import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PoolConfig } from "pg";
import { z } from "zod";
import {
  AgentControlSchema, CONTRACT_VERSION, ContractContextSchema, FixtureEventSchema, validateFixtureRun, validateVersion,
  type AgentControl, type ContractContext, type FixtureEvent, type RunConfig, type RunHandle,
} from "./foundation/contracts.js";
import { GidorahError, publicError } from "./foundation/errors.js";
import { PostgresJournal, type Lease } from "./storage/journal.js";
import { checkpointStore } from "./storage/bootstrap.js";
import { runFixtureAgent } from "./runtime/mastra.js";
import type { FixtureHooks } from "./execution/fixture-executor.js";

type Execution = { controller: AbortController; started: boolean; stopRequested: boolean; task?: Promise<void>; controlWrite?: Promise<void>; iterator?: AsyncGenerator<FixtureEvent> };
type BackendOptions = { leaseTtlMs?: number; pollMs?: number; fixtureHooks?: FixtureHooks };

function domainError(error: unknown): GidorahError | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof GidorahError) return current;
    current = current.cause;
  }
  return undefined;
}

export class GidorahBackend {
  readonly journal: PostgresJournal;
  private readonly checkpointer;
  private readonly active = new Map<string, Execution>();
  private closed = false;

  constructor(connection: PoolConfig, private readonly options: BackendOptions = {}) {
    this.journal = new PostgresJournal(connection);
    this.checkpointer = checkpointStore(connection);
  }

  run(target: string, input: RunConfig): RunHandle {
    const config = validateFixtureRun(target, input);
    return this.handle(randomUUID(), { target, config });
  }

  recover(runId: string, context: ContractContext): RunHandle {
    validateVersion(context);
    ContractContextSchema.parse(context);
    z.uuid().parse(runId);
    return this.handle(runId);
  }

  private handle(runId: string, start?: { target: string; config: RunConfig }): RunHandle {
    if (this.closed) throw new GidorahError("backend_closed", "The backend is closed.");
    if (this.active.has(runId)) throw new GidorahError("run_busy", "This backend already has a handle for the run.");
    const execution: Execution = { controller: new AbortController(), started: false, stopRequested: false };
    this.active.set(runId, execution);
    let consumed = false;
    return {
      runId,
      control: (input: AgentControl) => {
        validateVersion(input);
        const control = AgentControlSchema.parse(input);
        if (control.type !== "stop") throw new GidorahError("unsupported_control", "Only stop is implemented in the fixture slice; approvals, reviews and pause/resume are not enabled.");
        execution.stopRequested = true;
        execution.controller.abort();
        if (execution.started && !execution.controlWrite) {
          execution.controlWrite = this.journal.requestStop(runId);
          void execution.controlWrite.catch(() => execution.controller.abort());
        }
      },
      events: {
        [Symbol.asyncIterator]: () => {
          if (consumed) throw new GidorahError("stream_consumed", "A run handle has one execution consumer; use observe for another local subscription.");
          consumed = true;
          execution.iterator = this.execute(runId, execution, start);
          return execution.iterator;
        },
      },
    };
  }

  private async *execute(runId: string, execution: Execution, start?: { target: string; config: RunConfig }): AsyncGenerator<FixtureEvent> {
    let lease: Lease | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatTask: Promise<void> | undefined;
    let initializationComplete = false;
    let seq = 0;
    let taskDone = false;
    let taskError: unknown;
    try {
      if (this.closed) throw new GidorahError("backend_closed", "The backend is closed.");
      if (start) await this.journal.createRun(runId, start.target, start.config);
      const run = await this.journal.read(runId);
      if (run.terminal) { yield await this.journal.snapshot(runId); return; }
      lease = await this.journal.acquire(runId, this.options.leaseTtlMs ?? 5000);
      await this.journal.assertRecoverable(lease);
      execution.started = true;
      if (execution.stopRequested) await this.journal.requestStop(runId);
      const ownedLease = lease;
      heartbeat = setInterval(() => {
        if (heartbeatTask) return;
        heartbeatTask = this.journal.heartbeat(ownedLease).catch((error: unknown) => {
          taskError = error;
          execution.controller.abort();
        }).finally(() => { heartbeatTask = undefined; });
      }, Math.max(50, Math.floor(lease.ttlMs / 3)));
      heartbeat.unref();
      if (start) {
        const events = await this.journal.eventsAfter(runId, 0);
        for (const event of events) { seq = event.seq; yield event; }
      } else {
        const snapshot = await this.journal.snapshot(runId);
        seq = snapshot.seq;
        yield snapshot;
      }
      initializationComplete = true;
      execution.task = this.drive(lease, execution).catch((error: unknown) => { taskError = error; }).finally(() => { taskDone = true; });
      while (true) {
        const events = await this.journal.eventsAfter(runId, seq);
        for (const event of events) {
          seq = event.seq;
          yield event;
          if (event.type === "run.finished") return;
        }
        if (taskDone) {
          if (taskError) throw taskError;
          const completed = await this.journal.read(runId);
          if (completed.seq > seq) continue;
          if (completed.terminal) return;
          throw new GidorahError("missing_terminal", "Execution stopped without a committed terminal state; recovery is required.");
        }
        await sleep(this.options.pollMs ?? 100);
      }
    } catch (error) {
      if (initializationComplete) throw domainError(error) ?? new GidorahError("execution_unavailable", "Execution ownership or storage was lost. Recover from durable state; no terminal outcome is invented.");
      yield FixtureEventSchema.parse({ contractVersion: CONTRACT_VERSION, runId, seq: 0, type: "error", message: publicError(domainError(error) ?? error), fatal: true });
    } finally {
      execution.controller.abort();
      await execution.controlWrite?.catch(() => undefined);
      await execution.task;
      if (lease && !execution.task && execution.started) {
        await this.journal.requestStop(runId).catch(() => undefined);
        await this.journal.finish(lease, "stopped").catch(() => undefined);
      }
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatTask;
      if (lease) await this.journal.release(lease).catch(() => undefined);
      this.active.delete(runId);
    }
  }

  private async drive(lease: Lease, execution: Execution): Promise<void> {
    try {
      const run = await this.journal.read(lease.runId);
      if (run.stopRequested || execution.controller.signal.aborted) {
        await this.journal.finish(lease, "stopped");
        return;
      }
      await runFixtureAgent(this.journal, this.checkpointer, lease, execution.controller.signal, this.options.fixtureHooks);
      await execution.controlWrite;
      await this.journal.finish(lease, execution.controller.signal.aborted ? "stopped" : "completed");
    } catch (error) {
      const known = domainError(error);
      if (known?.code === "lease_lost") throw known;
      await execution.controlWrite;
      const stopped = execution.controller.signal.aborted || known?.code === "stop_requested" || known?.code === "budget_exhausted";
      await this.journal.finish(lease, stopped ? "stopped" : "failed", stopped ? undefined : publicError(known ?? error));
    }
  }

  async *observe(runId: string, context: ContractContext): AsyncGenerator<FixtureEvent> {
    validateVersion(context);
    ContractContextSchema.parse(context);
    z.uuid().parse(runId);
    const snapshot = await this.journal.snapshot(runId);
    if (snapshot.type !== "run.snapshot") throw new GidorahError("invalid_snapshot", "Expected a snapshot.");
    if (!snapshot.terminal && !this.active.has(runId)) throw new GidorahError("unsupported_attach", "Cross-process live attachment is not implemented. Use recover after the previous owner stops.");
    yield snapshot;
    if (snapshot.terminal) return;
    let seq = snapshot.seq;
    while (true) {
      const events = await this.journal.eventsAfter(runId, seq);
      for (const event of events) {
        seq = event.seq;
        yield event;
        if (event.type === "run.finished") return;
      }
      if (!this.active.has(runId)) {
        const run = await this.journal.read(runId);
        if (run.seq > seq) continue;
        if (run.terminal) return;
        throw new GidorahError("execution_unavailable", "The local execution owner disappeared; recover from durable state.");
      }
      await sleep(this.options.pollMs ?? 100);
    }
  }

  async getArtifact(runId: string, artifactRef: string, context: ContractContext): Promise<{ bytes: string; redacted: boolean }> {
    validateVersion(context);
    ContractContextSchema.parse(context);
    await this.journal.read(z.uuid().parse(runId));
    return this.journal.artifact(runId, artifactRef);
  }

  async getPendingReview(runId: string, _findingId: string, context: ContractContext): Promise<null> {
    validateVersion(context);
    ContractContextSchema.parse(context);
    await this.journal.read(z.uuid().parse(runId));
    return null;
  }

  async getReview(runId: string, findingId: string, context: ContractContext): Promise<null> {
    return this.getPendingReview(runId, findingId, context);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const execution of this.active.values()) execution.controller.abort();
    await Promise.allSettled([...this.active.values()].flatMap((execution) => execution.iterator ? [execution.iterator.return(undefined)] : []));
    this.active.clear();
    await this.checkpointer.end();
    await this.journal.close();
  }
}

