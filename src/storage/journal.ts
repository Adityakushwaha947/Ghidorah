import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import {
  capsFor, CONTRACT_VERSION, FIXTURE_TARGET, FixtureEventSchema, RUNTIME_VERSION,
  TerminalSchema, validateFixtureRun, type Budget, type EventPayload, type FixtureEvent, type RunConfig, type Terminal,
} from "../foundation/contracts.js";
import { digest, sha256 } from "../foundation/digest.js";
import { GidorahError } from "../foundation/errors.js";
import { SCHEMA } from "./schema.js";

export type Lease = { runId: string; owner: string; epoch: number; ttlMs: number };
export type RunRecord = {
  id: string; config: RunConfig; target: string; seq: number; spent: Budget;
  terminal?: Terminal; stopRequested: boolean; startedAt: Date;
};
type RunRow = QueryResultRow & {
  id: string; config: unknown; target: string; runtime_version: string;
  seq: number; spent_tokens: number; spent_steps: number; started_at: Date; finished_at: Date | null;
  terminal: unknown; stop_requested: boolean; lease_owner: string | null; lease_epoch: number;
  lease_until: Date | null; db_now: Date;
};
export type ActionRecord = { callId: string; tool: string; state: string; artifactRef: string | null };

export class PostgresJournal {
  readonly pool: Pool;

  constructor(connection: PoolConfig) {
    this.pool = new Pool({ ...connection, max: 4, connectionTimeoutMillis: 8000, statement_timeout: 10_000, application_name: "gidorah-mastra-journal" });
  }

  async setup(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('gidorah-mastra-schema-v1'))");
      await client.query(SCHEMA);
    });
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async transaction<ResultType>(operation: (client: PoolClient) => Promise<ResultType>): Promise<ResultType> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private record(row: RunRow): RunRecord {
    if (row.runtime_version !== RUNTIME_VERSION) throw new GidorahError("runtime_version_mismatch", "The stored runtime is incompatible; do not resume without migration.");
    return {
      id: row.id, target: row.target, config: validateFixtureRun(row.target, row.config), seq: row.seq,
      spent: { tokens: row.spent_tokens, steps: row.spent_steps, wallSec: Math.max(0, ((row.finished_at ?? row.db_now).getTime() - row.started_at.getTime()) / 1000) },
      ...(row.terminal ? { terminal: TerminalSchema.parse(row.terminal) } : {}),
      stopRequested: row.stop_requested, startedAt: row.started_at,
    };
  }

  private async locked(client: PoolClient, runId: string): Promise<RunRow> {
    const result = await client.query<RunRow>("WITH locked AS MATERIALIZED (SELECT * FROM gidorah_mastra.runs WHERE id=$1 FOR UPDATE) SELECT locked.*,clock_timestamp() AS db_now FROM locked", [runId]);
    const row = result.rows[0];
    if (!row) throw new GidorahError("run_not_found", "No such run.");
    this.record(row);
    return row;
  }

  private checkOwner(row: RunRow, lease: Lease): void {
    if (row.lease_owner !== lease.owner || row.lease_epoch !== lease.epoch || !row.lease_until || row.lease_until <= row.db_now) {
      throw new GidorahError("lease_lost", "This worker no longer owns execution.");
    }
    if (row.terminal) throw new GidorahError("run_finished", "The run is already finished.");
  }

  private checkDispatch(row: RunRow, lease: Lease): void {
    this.checkOwner(row, lease);
    if (row.stop_requested) throw new GidorahError("stop_requested", "The run was stopped.");
    const run = this.record(row);
    if (run.spent.wallSec >= run.config.capWallSec) throw new GidorahError("budget_exhausted", "The wall-time limit is exhausted.");
  }

  private async append(client: PoolClient, runId: string, payload: EventPayload): Promise<FixtureEvent> {
    const result = await client.query<{ seq: number }>("UPDATE gidorah_mastra.runs SET seq=seq+1 WHERE id=$1 RETURNING seq", [runId]);
    const event = FixtureEventSchema.parse({ ...payload, contractVersion: CONTRACT_VERSION, runId, seq: result.rows[0]!.seq });
    await client.query("INSERT INTO gidorah_mastra.events(run_id,seq,payload) VALUES ($1,$2,$3)", [runId, event.seq, event]);
    return event;
  }

  private async charge(client: PoolClient, row: RunRow, tokens: number): Promise<void> {
    const run = this.record(row);
    if (run.spent.steps + 1 > run.config.capSteps || run.spent.tokens + tokens > run.config.capTokens) {
      throw new GidorahError("budget_exhausted", "The cumulative fixture budget is exhausted.");
    }
    await client.query("UPDATE gidorah_mastra.runs SET spent_steps=spent_steps+1, spent_tokens=spent_tokens+$2 WHERE id=$1", [row.id, tokens]);
    await this.append(client, row.id, { type: "budget", caps: capsFor(run.config), spent: { ...run.spent, steps: run.spent.steps + 1, tokens: run.spent.tokens + tokens } });
  }

  async createRun(runId: string, target: string, input: unknown): Promise<void> {
    const config = validateFixtureRun(target, input);
    await this.transaction(async (client) => {
      await client.query("INSERT INTO gidorah_mastra.runs(id,runtime_version,config,target) VALUES ($1,$2,$3,$4)", [runId, RUNTIME_VERSION, config, target]);
      await this.append(client, runId, { type: "run.started", target: FIXTURE_TARGET, mode: "pentest", capabilities: ["agentic_pentesting"], caps: capsFor(config) });
      await client.query("INSERT INTO gidorah_mastra.fixture_targets(run_id) VALUES ($1)", [runId]);
    });
  }

  async read(runId: string): Promise<RunRecord> {
    const result = await this.pool.query<RunRow>("SELECT *, clock_timestamp() AS db_now FROM gidorah_mastra.runs WHERE id=$1", [runId]);
    if (!result.rows[0]) throw new GidorahError("run_not_found", "No such run.");
    return this.record(result.rows[0]);
  }

  async snapshot(runId: string): Promise<FixtureEvent> {
    const run = await this.read(runId);
    return FixtureEventSchema.parse({
      contractVersion: CONTRACT_VERSION, runId, seq: run.seq, type: "run.snapshot",
      target: run.target, mode: "pentest", capabilities: ["agentic_pentesting"],
      caps: capsFor(run.config), spent: run.spent, findings: [], installDecisions: [],
      pendingApprovals: [], pendingReviews: [], ...(run.terminal ? { terminal: run.terminal } : {}),
    });
  }

  async eventsAfter(runId: string, seq: number): Promise<FixtureEvent[]> {
    const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM gidorah_mastra.events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT 1000", [runId, seq]);
    return result.rows.map((row) => FixtureEventSchema.parse(row.payload));
  }

  async acquire(runId: string, ttlMs = 5000): Promise<Lease> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 200 || ttlMs > 60_000) throw new GidorahError("invalid_lease", "Lease TTL must be between 200 and 60000 milliseconds.");
    return this.transaction(async (client) => {
      const row = await this.locked(client, runId);
      if (row.terminal) throw new GidorahError("run_finished", "The run is already finished.");
      if (row.lease_owner && row.lease_until && row.lease_until > row.db_now) throw new GidorahError("run_busy", "Another worker owns this run; wait for its lease to expire.");
      const lease: Lease = { runId, owner: randomUUID(), epoch: row.lease_epoch + 1, ttlMs };
      await client.query("UPDATE gidorah_mastra.runs SET lease_owner=$2,lease_epoch=$3,lease_until=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1", [runId, lease.owner, lease.epoch, ttlMs]);
      return lease;
    });
  }

  async heartbeat(lease: Lease): Promise<void> {
    const result = await this.pool.query("UPDATE gidorah_mastra.runs SET lease_until=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>clock_timestamp() AND terminal IS NULL", [lease.runId, lease.owner, lease.epoch, lease.ttlMs]);
    if (result.rowCount !== 1) throw new GidorahError("lease_lost", "Heartbeat rejected for a stale execution owner.");
  }

  async release(lease: Lease): Promise<void> {
    await this.pool.query("UPDATE gidorah_mastra.runs SET lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3", [lease.runId, lease.owner, lease.epoch]);
  }

  async requestStop(runId: string): Promise<void> {
    await this.pool.query("UPDATE gidorah_mastra.runs SET stop_requested=true WHERE id=$1 AND terminal IS NULL", [runId]);
  }

  private async hasUncertainDispatch(client: PoolClient, runId: string): Promise<boolean> {
    const result = await client.query("SELECT 1 FROM gidorah_mastra.actions WHERE run_id=$1 AND state='dispatched' UNION ALL SELECT 1 FROM gidorah_mastra.model_calls WHERE run_id=$1 AND state='dispatched' LIMIT 1", [runId]);
    return Boolean(result.rowCount);
  }

  async assertRecoverable(lease: Lease): Promise<void> {
    await this.transaction(async (client) => {
      const row = await this.locked(client, lease.runId);
      this.checkOwner(row, lease);
      if (await this.hasUncertainDispatch(client, lease.runId)) throw new GidorahError("uncertain_execution", "A dispatch lacks a committed result. Recovery is blocked until trusted reconciliation; do not create a replacement attempt.");
    });
  }

  async beginModel(lease: Lease, key: string, request: unknown): Promise<unknown | undefined> {
    const requestDigest = digest(request);
    return this.transaction(async (client) => {
      const row = await this.locked(client, lease.runId);
      this.checkDispatch(row, lease);
      const previous = (await client.query("SELECT * FROM gidorah_mastra.model_calls WHERE run_id=$1 AND call_key=$2", [lease.runId, key])).rows[0];
      if (previous) {
        if (previous.request_digest !== requestDigest) throw new GidorahError("replay_mismatch", "The replayed model request differs from its recorded input.");
        if (previous.state !== "completed") throw new GidorahError("uncertain_execution", "The previous model dispatch has no finalized response.");
        return previous.response;
      }
      if (await this.hasUncertainDispatch(client, lease.runId)) throw new GidorahError("uncertain_execution", "An unresolved dispatch blocks new model calls; a new ID cannot bypass reconciliation.");
      await this.charge(client, row, 2);
      await client.query("INSERT INTO gidorah_mastra.model_calls(run_id,call_key,request_digest,request,state) VALUES ($1,$2,$3,$4,'dispatched')", [lease.runId, key, requestDigest, request]);
      await this.append(client, lease.runId, { type: "step", stepId: key, summary: "Synthetic fixture model dispatch; not a paid provider call." });
      return undefined;
    });
  }

  async completeModel(lease: Lease, key: string, response: unknown): Promise<void> {
    await this.transaction(async (client) => {
      this.checkOwner(await this.locked(client, lease.runId), lease);
      const result = await client.query("UPDATE gidorah_mastra.model_calls SET state='completed',response=$3 WHERE run_id=$1 AND call_key=$2 AND state='dispatched'", [lease.runId, key, response]);
      if (result.rowCount !== 1) throw new GidorahError("invalid_transition", "Model completion has no matching dispatch.");
    });
  }

  async prepareAction(lease: Lease, callId: string, tool: string, args: unknown): Promise<string | undefined> {
    const argsDigest = digest(args);
    return this.transaction(async (client) => {
      const row = await this.locked(client, lease.runId);
      this.checkDispatch(row, lease);
      const previous = (await client.query("SELECT * FROM gidorah_mastra.actions WHERE run_id=$1 AND call_id=$2", [lease.runId, callId])).rows[0];
      if (previous) {
        if (previous.tool !== tool || previous.args_digest !== argsDigest) throw new GidorahError("replay_mismatch", "The recorded action cannot be changed during replay.");
        if (previous.state === "completed") return String(previous.artifact_ref);
        if (previous.state === "dispatched") throw new GidorahError("uncertain_execution", "The prior action may have executed; blind replay is forbidden.");
        return undefined;
      }
      const unfinished = await client.query("SELECT 1 FROM gidorah_mastra.actions WHERE run_id=$1 AND state!='completed' LIMIT 1", [lease.runId]);
      if (unfinished.rowCount) throw new GidorahError("action_in_progress", "Another logical action is unresolved; new IDs cannot bypass it.");
      const modelRecords = await client.query<{ response: { tool_calls?: { id?: string; name: string; args: unknown }[] } }>("SELECT response FROM gidorah_mastra.model_calls WHERE run_id=$1 AND state='completed'", [lease.runId]);
      const proposal = modelRecords.rows.flatMap((record) => record.response.tool_calls ?? []).find((call) => call.id === callId);
      if (!proposal || proposal.name !== tool || digest(proposal.args) !== argsDigest) throw new GidorahError("unrecorded_action", "Only a finalized, committed model proposal can be dispatched.");
      await this.charge(client, row, 0);
      await client.query("INSERT INTO gidorah_mastra.actions(run_id,call_id,tool,args_digest,state) VALUES ($1,$2,$3,$4,'prepared')", [lease.runId, callId, tool, argsDigest]);
      await this.append(client, lease.runId, { type: "tool.call", callId, tool, argsSummary: "Registered fixture operation; no external inputs." });
      return undefined;
    });
  }

  async dispatchAction(lease: Lease, callId: string): Promise<void> {
    await this.transaction(async (client) => {
      this.checkDispatch(await this.locked(client, lease.runId), lease);
      const result = await client.query("UPDATE gidorah_mastra.actions SET state='dispatched' WHERE run_id=$1 AND call_id=$2 AND state='prepared'", [lease.runId, callId]);
      if (result.rowCount !== 1) throw new GidorahError("invalid_transition", "Action is not prepared for dispatch.");
    });
  }

  async fixtureEffect(lease: Lease, callId: string, tool: "fixture_increment" | "fixture_read"): Promise<{ counter: number }> {
    return this.transaction(async (client) => {
      this.checkDispatch(await this.locked(client, lease.runId), lease);
      const action = (await client.query("SELECT state,tool FROM gidorah_mastra.actions WHERE run_id=$1 AND call_id=$2", [lease.runId, callId])).rows[0];
      if (action?.state !== "dispatched" || action.tool !== tool) throw new GidorahError("dispatch_denied", "Fixture effect requires an admitted action.");
      const query = tool === "fixture_increment"
        ? "UPDATE gidorah_mastra.fixture_targets SET counter=counter+1 WHERE run_id=$1 RETURNING counter"
        : "SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1";
      const result = await client.query<{ counter: number }>(query, [lease.runId]);
      if (!result.rows[0]) throw new GidorahError("fixture_missing", "The fixture target is unavailable.");
      return result.rows[0];
    });
  }

  async completeAction(lease: Lease, callId: string, counter: number): Promise<string> {
    if (!Number.isSafeInteger(counter) || counter < 0) throw new GidorahError("invalid_artifact", "Fixture output must be a nonnegative integer.");
    const bytes = JSON.stringify({ counter });
    const hash = sha256(bytes);
    const ref = `sha256:${hash}`;
    await this.transaction(async (client) => {
      this.checkOwner(await this.locked(client, lease.runId), lease);
      await client.query("INSERT INTO gidorah_mastra.artifacts(run_id,ref,bytes,sha256) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [lease.runId, ref, bytes, hash]);
      const result = await client.query("UPDATE gidorah_mastra.actions SET state='completed',artifact_ref=$3 WHERE run_id=$1 AND call_id=$2 AND state='dispatched'", [lease.runId, callId, ref]);
      if (result.rowCount !== 1) throw new GidorahError("invalid_transition", "Action completion has no matching dispatch.");
      await this.append(client, lease.runId, { type: "tool.result", callId, ok: true, summary: "Synthetic counter observation committed.", artifactRef: ref });
    });
    return ref;
  }

  async artifact(runId: string, ref: string): Promise<{ bytes: string; redacted: boolean }> {
    const result = await this.pool.query<{ bytes: string; sha256: string }>("SELECT bytes,sha256 FROM gidorah_mastra.artifacts WHERE run_id=$1 AND ref=$2", [runId, ref]);
    const row = result.rows[0];
    if (!row || sha256(row.bytes) !== row.sha256 || ref !== `sha256:${row.sha256}`) throw new GidorahError("evidence_integrity", "The artifact is missing or its digest does not match.");
    return { bytes: row.bytes, redacted: true };
  }

  async actions(runId: string): Promise<ActionRecord[]> {
    const result = await this.pool.query("SELECT call_id,tool,state,artifact_ref FROM gidorah_mastra.actions WHERE run_id=$1 ORDER BY call_id", [runId]);
    return result.rows.map((row) => ({ callId: row.call_id, tool: row.tool, state: row.state, artifactRef: row.artifact_ref }));
  }

  async finish(lease: Lease, outcome: Terminal["outcome"], message?: string): Promise<void> {
    await this.transaction(async (client) => {
      const row = await this.locked(client, lease.runId);
      if (row.terminal) return;
      this.checkOwner(row, lease);
      const unresolved = await this.hasUncertainDispatch(client, lease.runId);
      if (unresolved && outcome === "completed") throw new GidorahError("uncertain_execution", "An unresolved dispatch cannot produce successful completion.");
      if (message) await this.append(client, lease.runId, { type: "error", message, fatal: true });
      const terminal: Terminal = { outcome: row.stop_requested && outcome === "completed" ? "stopped" : outcome, cleanupOk: !unresolved };
      await client.query("UPDATE gidorah_mastra.runs SET terminal=$2,finished_at=clock_timestamp() WHERE id=$1", [lease.runId, terminal]);
      await this.append(client, lease.runId, { type: "run.finished", ...terminal, confirmed: 0, needsHuman: 0, discarded: 0 });
    });
  }
}
