import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { GidorahError } from "@ghidorah/foundation";
import type { Lease, PostgresJournal } from "../storage/journal.js";

export type FaultPoint = "after-intent" | "after-dispatch" | "after-effect" | "after-result" | "after-model";
export type FixtureHooks = { at?: (point: FaultPoint) => Promise<void>; delayBeforeDispatchMs?: number };
const argsSchema = z.strictObject({});
const toolSchema = z.enum(["fixture_increment", "fixture_read"]);

export class FixtureExecutor {
  constructor(
    private readonly journal: PostgresJournal,
    private readonly lease: Lease,
    private readonly signal: AbortSignal,
    private readonly hooks: FixtureHooks = {},
  ) {}

  async execute(callId: string | undefined, name: string, input: unknown): Promise<string> {
    if (this.signal.aborted) throw new GidorahError("stop_requested", "Execution cancelled before admission.");
    const tool = toolSchema.safeParse(name);
    const args = argsSchema.safeParse(input);
    if (!callId || !tool.success || !args.success)
      throw new GidorahError(
        "tool_denied",
        "Only registered fixture tools with finalized IDs and empty arguments can execute.",
      );
    const cachedRef = await this.journal.prepareAction(this.lease, callId, tool.data, args.data);
    if (cachedRef) return (await this.journal.artifact(this.lease.runId, cachedRef)).bytes;
    await this.hooks.at?.("after-intent");
    if (this.hooks.delayBeforeDispatchMs) {
      try {
        await sleep(this.hooks.delayBeforeDispatchMs, undefined, { signal: this.signal });
      } catch {
        throw new GidorahError("stop_requested", "Fixture wait cancelled before dispatch.");
      }
    }
    if (this.signal.aborted) throw new GidorahError("stop_requested", "Execution cancelled before dispatch.");
    await this.journal.dispatchAction(this.lease, callId);
    await this.hooks.at?.("after-dispatch");
    const result = await this.journal.fixtureEffect(this.lease, callId, tool.data);
    await this.hooks.at?.("after-effect");
    const ref = await this.journal.completeAction(this.lease, callId, result.counter);
    await this.hooks.at?.("after-result");
    return (await this.journal.artifact(this.lease.runId, ref)).bytes;
  }
}
