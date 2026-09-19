import type { QueryResultRow } from "pg";
import {
  ModelResponseSchema,
  ModelUsageSchema,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
} from "@ghidorah/contracts";
import { GidorahError } from "@ghidorah/foundation";
import type { DispatchRecord, ModelDispatchJournal } from "@ghidorah/model";
import type { Lease, PostgresJournal } from "./journal.js";

type DispatchRow = QueryResultRow & {
  route_id: string;
  provider: string;
  requested_model: string;
  request_digest: string;
  state: "reserved" | "completed" | "failed";
  reserved_tokens: number;
  observed_input_tokens: number | null;
  observed_output_tokens: number | null;
  final_usage_known: boolean;
  response: unknown;
};

export type InputTokenBound = (request: ModelRequest, canonicalRequest: string) => number;

/**
 * Conservative input bound: byte-level tokenizers never emit a token shorter than one byte of text, so the
 * UTF-8 length of the canonical request bounds the prompt tokens. A fixed allowance per message and tool covers
 * chat-template control tokens the provider adds. This is an accepted assumption for reservation, not a price.
 */
export const byteInputBound: InputTokenBound = (request, canonicalRequest) =>
  Buffer.byteLength(canonicalRequest, "utf8") + 32 * (request.messages.length + request.tools.length + 1);

/**
 * Lease-fenced, run-bound dispatch journal for the model gateway. Every operation runs inside the run's ownership
 * fence, so a stale worker cannot reserve, record usage, or commit. At most one dispatch per run may be unresolved.
 * A failed dispatch without final usage keeps its reservation and blocks new dispatch until a trusted reconciliation.
 */
export class PostgresModelDispatchJournal implements ModelDispatchJournal {
  constructor(
    private readonly journal: PostgresJournal,
    private readonly lease: Lease,
    private readonly inputBound: InputTokenBound = byteInputBound,
  ) {}

  private async row(
    client: { query: PostgresJournal["pool"]["query"] },
    requestId: string,
  ): Promise<DispatchRow | undefined> {
    const result = await client.query<DispatchRow>(
      "SELECT * FROM gidorah_mastra.model_dispatches WHERE run_id=$1 AND request_id=$2 FOR UPDATE",
      [this.lease.runId, requestId],
    );
    return result.rows[0];
  }

  async reserve(
    record: DispatchRecord,
    request: ModelRequest,
  ): Promise<{ state: "reserved"; tokens: number } | { state: "completed"; response: unknown }> {
    return this.journal.fenced(this.lease, async ({ client, run }) => {
      const existing = await this.row(client, record.requestId);
      if (existing) {
        if (
          existing.route_id !== record.routeId ||
          existing.provider !== record.provider ||
          existing.requested_model !== record.requestedModel ||
          existing.request_digest !== record.requestDigest
        )
          throw new GidorahError(
            "dispatch_mismatch",
            "A request ID cannot be reused with a different payload or route.",
          );
        if (existing.state === "completed") return { state: "completed", response: existing.response };
        throw new GidorahError(
          "dispatch_uncertain",
          "This dispatch has no committed outcome; blind replay is refused until it is reconciled.",
        );
      }
      const unresolved = await client.query<{ reserved: number }>(
        "SELECT COALESCE(SUM(reserved_tokens),0)::int AS reserved FROM gidorah_mastra.model_dispatches WHERE run_id=$1 AND (state='reserved' OR (state='failed' AND NOT final_usage_known))",
        [this.lease.runId],
      );
      if (unresolved.rows[0]!.reserved > 0)
        throw new GidorahError("dispatch_pending", "Another model dispatch for this run is unresolved.");
      const input = this.inputBound(request, record.canonicalRequest);
      if (!Number.isSafeInteger(input) || input <= 0)
        throw new GidorahError("unbounded_input", "The prompt size could not be bounded for reservation.");
      const tokens = input + request.maxOutputTokens;
      if (run.spent.tokens + tokens > run.config.capTokens)
        throw new GidorahError("budget_exhausted", "The token reservation exceeds the remaining run budget.");
      if (run.spent.steps + 1 > run.config.capSteps)
        throw new GidorahError("budget_exhausted", "The step budget is exhausted.");
      await client.query(
        "INSERT INTO gidorah_mastra.model_dispatches(run_id,request_id,route_id,provider,requested_model,request_digest,canonical_request,state,reserved_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8)",
        [
          this.lease.runId,
          record.requestId,
          record.routeId,
          record.provider,
          record.requestedModel,
          record.requestDigest,
          record.canonicalRequest,
          tokens,
        ],
      );
      return { state: "reserved", tokens };
    });
  }

  async recordUsage(requestId: string, cumulative: ModelUsage): Promise<void> {
    const usage = ModelUsageSchema.parse(cumulative);
    await this.journal.fenced(this.lease, async ({ client }) => {
      const result = await client.query(
        "UPDATE gidorah_mastra.model_dispatches SET observed_input_tokens=$3, observed_output_tokens=$4 WHERE run_id=$1 AND request_id=$2 AND state='reserved' AND ($3 >= COALESCE(observed_input_tokens,0)) AND ($4 >= COALESCE(observed_output_tokens,0)) AND $3::int + $4::int <= reserved_tokens",
        [this.lease.runId, requestId, usage.inputTokens, usage.outputTokens],
      );
      if (result.rowCount !== 1)
        throw new GidorahError(
          "usage_rejected",
          "Usage must be cumulative, within reservation, and for a live dispatch.",
        );
    });
  }

  async complete(requestId: string, response: ModelResponse): Promise<void> {
    const checked = ModelResponseSchema.parse(response);
    if (checked.requestId !== requestId)
      throw new GidorahError("dispatch_mismatch", "The response identity differs from the dispatch.");
    await this.journal.fenced(this.lease, async ({ client, charge }) => {
      const result = await client.query(
        "UPDATE gidorah_mastra.model_dispatches SET state='completed', response=$3, observed_input_tokens=$4, observed_output_tokens=$5, final_usage_known=true WHERE run_id=$1 AND request_id=$2 AND state='reserved' AND $4::int + $5::int <= reserved_tokens",
        [this.lease.runId, requestId, checked, checked.usage.inputTokens, checked.usage.outputTokens],
      );
      if (result.rowCount !== 1)
        throw new GidorahError("dispatch_state", "Only a live dispatch within its reservation can complete.");
      await charge(checked.usage.inputTokens + checked.usage.outputTokens);
    });
  }

  async fail(
    requestId: string,
    failure: { code: string; observedUsage: ModelUsage | null; finalUsageKnown: false },
  ): Promise<void> {
    const observed = failure.observedUsage ? ModelUsageSchema.parse(failure.observedUsage) : null;
    await this.journal.fenced(this.lease, async ({ client }) => {
      const result = await client.query(
        "UPDATE gidorah_mastra.model_dispatches SET state='failed', failure_code=$3, observed_input_tokens=COALESCE($4, observed_input_tokens), observed_output_tokens=COALESCE($5, observed_output_tokens), final_usage_known=false WHERE run_id=$1 AND request_id=$2 AND state='reserved'",
        [this.lease.runId, requestId, failure.code, observed?.inputTokens ?? null, observed?.outputTokens ?? null],
      );
      if (result.rowCount !== 1) throw new GidorahError("dispatch_state", "Only a live dispatch can fail.");
    });
  }

  /**
   * Trusted reconciliation of a failed dispatch whose final provider usage has been established out of band.
   * Charges the run once and releases the block on new dispatch. Never callable by the model.
   */
  async reconcile(requestId: string, finalUsage: ModelUsage): Promise<void> {
    const usage = ModelUsageSchema.parse(finalUsage);
    await this.journal.fenced(this.lease, async ({ client, charge }) => {
      const result = await client.query(
        "UPDATE gidorah_mastra.model_dispatches SET observed_input_tokens=$3, observed_output_tokens=$4, final_usage_known=true WHERE run_id=$1 AND request_id=$2 AND state='failed' AND NOT final_usage_known AND $3 >= COALESCE(observed_input_tokens,0) AND $4 >= COALESCE(observed_output_tokens,0)",
        [this.lease.runId, requestId, usage.inputTokens, usage.outputTokens],
      );
      if (result.rowCount !== 1)
        throw new GidorahError(
          "dispatch_state",
          "Only an unreconciled failed dispatch with consistent usage can be reconciled.",
        );
      await charge(usage.inputTokens + usage.outputTokens);
    });
  }

  async status(
    requestId: string,
  ): Promise<{ state: string; finalUsageKnown: boolean; observed: ModelUsage | null } | null> {
    const result = await this.journal.pool.query<DispatchRow>(
      "SELECT * FROM gidorah_mastra.model_dispatches WHERE run_id=$1 AND request_id=$2",
      [this.lease.runId, requestId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      state: row.state,
      finalUsageKnown: row.final_usage_known,
      observed:
        row.observed_input_tokens === null || row.observed_output_tokens === null
          ? null
          : { inputTokens: row.observed_input_tokens, outputTokens: row.observed_output_tokens },
    };
  }
}
