import { FixtureEventSchema, type Budget, type FixtureEvent, type Terminal } from "./fixture-contract.js";
import { GidorahError } from "./errors.js";

export type FixtureView = { runId: string; seq: number; caps: Budget; spent: Budget; terminal?: Terminal };

export function applyEvent(state: FixtureView | undefined, input: unknown): FixtureView {
  const event: FixtureEvent = FixtureEventSchema.parse(input);
  if (state && state.runId !== event.runId)
    throw new GidorahError("run_mismatch", "Cannot merge events from different runs.");
  if (event.type === "run.snapshot")
    return { runId: event.runId, seq: event.seq, caps: event.caps, spent: event.spent, terminal: event.terminal };
  if (state && event.seq <= state.seq) return state;
  if (!state) {
    if (event.type !== "run.started")
      throw new GidorahError("missing_snapshot", "The first event must establish run state.");
    return { runId: event.runId, seq: event.seq, caps: event.caps, spent: { tokens: 0, steps: 0, wallSec: 0 } };
  }
  if (state.terminal) throw new GidorahError("terminal_transition", "A finished run cannot accept new transitions.");
  if (event.seq !== state.seq + 1)
    throw new GidorahError("event_gap", "Missing committed events; rebuild from a snapshot.");
  if (event.type === "run.started") throw new GidorahError("duplicate_start", "The run already started.");
  return {
    ...state,
    seq: event.seq,
    ...(event.type === "budget" ? { caps: event.caps, spent: event.spent } : {}),
    ...(event.type === "run.finished"
      ? {
          terminal: {
            outcome: event.outcome,
            cleanupOk: event.cleanupOk,
            ...(event.reportPath ? { reportPath: event.reportPath } : {}),
          },
        }
      : {}),
  };
}
