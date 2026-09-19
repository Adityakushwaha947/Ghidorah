import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseConfig } from "../../src/config.js";
import { FIXTURE_TARGET, fixtureConfig } from "@ghidorah/foundation";
import { canonicalJson, sha256 } from "@ghidorah/foundation";
import type { DispatchRecord } from "@ghidorah/model";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { PostgresJournal, type Lease } from "../../src/storage/journal.js";
import { PostgresModelDispatchJournal } from "../../src/storage/model-dispatch-journal.js";
import { modelRequest, modelResponse } from "../helpers/contract-fixtures.js";

const connection = databaseConfig();
const journal = new PostgresJournal(connection);

before(async () => {
  await initializeDatabase(connection);
});
after(async () => {
  await journal.close();
});

async function ownedRun(capTokens = 5000): Promise<Lease> {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig({ capTokens }));
  return journal.acquire(runId, 5000);
}

function record(requestId = "dispatch-1", overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  const canonical = canonicalJson(modelRequest({ requestId }));
  return {
    requestId,
    routeId: "route-1",
    provider: "openrouter",
    requestedModel: "synthetic-model",
    canonicalRequest: canonical,
    requestDigest: sha256(canonical),
    ...overrides,
  };
}

test("reserve, usage, complete, then replay without a second reservation", async () => {
  const lease = await ownedRun();
  const dispatches = new PostgresModelDispatchJournal(journal, lease);
  const reservation = await dispatches.reserve(record(), modelRequest());
  assert.equal(reservation.state, "reserved");
  if (reservation.state !== "reserved") return;
  assert.ok(reservation.tokens > modelRequest().maxOutputTokens);
  await dispatches.recordUsage("dispatch-1", { inputTokens: 10, outputTokens: 1 });
  await dispatches.recordUsage("dispatch-1", { inputTokens: 10, outputTokens: 3 });
  await assert.rejects(dispatches.recordUsage("dispatch-1", { inputTokens: 9, outputTokens: 3 }), {
    code: "usage_rejected",
  });
  const response = modelResponse({ usage: { inputTokens: 10, outputTokens: 4 } });
  await dispatches.complete("dispatch-1", response);
  const replay = await dispatches.reserve(record(), modelRequest());
  assert.deepEqual(replay, { state: "completed", response });
  const run = await journal.read(lease.runId);
  assert.equal(run.spent.tokens, 14, "final usage charged exactly once");
  assert.equal(run.spent.steps, 1);
  await assert.rejects(dispatches.complete("dispatch-1", response), { code: "dispatch_state" });
});

test("a request ID with a different payload or route is rejected", async () => {
  const lease = await ownedRun();
  const dispatches = new PostgresModelDispatchJournal(journal, lease);
  await dispatches.reserve(record(), modelRequest());
  await dispatches.complete("dispatch-1", modelResponse());
  await assert.rejects(dispatches.reserve(record("dispatch-1", { requestDigest: sha256("changed") }), modelRequest()), {
    code: "dispatch_mismatch",
  });
  await assert.rejects(dispatches.reserve(record("dispatch-1", { routeId: "route-2" }), modelRequest()), {
    code: "dispatch_mismatch",
  });
});

test("one unresolved dispatch per run; a new ID cannot bypass it", async () => {
  const lease = await ownedRun();
  const dispatches = new PostgresModelDispatchJournal(journal, lease);
  await dispatches.reserve(record(), modelRequest());
  await assert.rejects(dispatches.reserve(record("dispatch-2"), modelRequest({ requestId: "dispatch-2" })), {
    code: "dispatch_pending",
  });
  await assert.rejects(dispatches.reserve(record(), modelRequest()), { code: "dispatch_uncertain" });
  await assert.rejects(journal.assertRecoverable(lease), { code: "uncertain_execution" });
});

test("a failed dispatch without final usage keeps its reservation until trusted reconciliation", async () => {
  const lease = await ownedRun();
  const dispatches = new PostgresModelDispatchJournal(journal, lease);
  await dispatches.reserve(record(), modelRequest());
  await dispatches.fail("dispatch-1", {
    code: "timeout",
    observedUsage: { inputTokens: 10, outputTokens: 2 },
    finalUsageKnown: false,
  });
  assert.deepEqual(await dispatches.status("dispatch-1"), {
    state: "failed",
    finalUsageKnown: false,
    observed: { inputTokens: 10, outputTokens: 2 },
  });
  await assert.rejects(dispatches.reserve(record("dispatch-2"), modelRequest({ requestId: "dispatch-2" })), {
    code: "dispatch_pending",
  });
  await assert.rejects(dispatches.reserve(record(), modelRequest()), { code: "dispatch_uncertain" });
  assert.equal((await journal.read(lease.runId)).spent.tokens, 0, "nothing charged before reconciliation");
  await assert.rejects(dispatches.reconcile("dispatch-1", { inputTokens: 9, outputTokens: 2 }), {
    code: "dispatch_state",
  });
  await dispatches.reconcile("dispatch-1", { inputTokens: 10, outputTokens: 5 });
  assert.equal((await journal.read(lease.runId)).spent.tokens, 15);
  const next = await dispatches.reserve(record("dispatch-2"), modelRequest({ requestId: "dispatch-2" }));
  assert.equal(next.state, "reserved");
  await assert.rejects(dispatches.reconcile("dispatch-1", { inputTokens: 10, outputTokens: 5 }), {
    code: "dispatch_state",
  });
});

test("reservations are bounded by the remaining run budget", async () => {
  const lease = await ownedRun(300);
  const dispatches = new PostgresModelDispatchJournal(journal, lease);
  await assert.rejects(dispatches.reserve(record(), modelRequest({ maxOutputTokens: 200 })), {
    code: "budget_exhausted",
  });
  const small = new PostgresModelDispatchJournal(journal, lease, () => 10);
  const reservation = await small.reserve(record(), modelRequest({ maxOutputTokens: 200 }));
  assert.deepEqual(reservation, { state: "reserved", tokens: 210 });
  await assert.rejects(small.recordUsage("dispatch-1", { inputTokens: 11, outputTokens: 200 }), {
    code: "usage_rejected",
  });
  await assert.rejects(small.complete("dispatch-1", modelResponse({ usage: { inputTokens: 11, outputTokens: 200 } })), {
    code: "dispatch_state",
  });
});

test("a stale lease cannot reserve, record, or complete", async () => {
  const lease = await ownedRun();
  const stale = new PostgresModelDispatchJournal(journal, lease);
  await stale.reserve(record(), modelRequest());
  await journal.release(lease);
  const successor = await journal.acquire(lease.runId, 5000);
  assert.equal(successor.epoch, lease.epoch + 1);
  await assert.rejects(stale.recordUsage("dispatch-1", { inputTokens: 1, outputTokens: 1 }), { code: "lease_lost" });
  await assert.rejects(stale.complete("dispatch-1", modelResponse()), { code: "lease_lost" });
  await assert.rejects(stale.reserve(record("dispatch-2"), modelRequest({ requestId: "dispatch-2" })), {
    code: "lease_lost",
  });
  const owned = new PostgresModelDispatchJournal(journal, successor);
  await assert.rejects(owned.reserve(record(), modelRequest()), { code: "dispatch_uncertain" });
});

test("a stopped run refuses new reservations", async () => {
  const lease = await ownedRun();
  await journal.requestStop(lease.runId);
  const dispatches = new PostgresModelDispatchJournal(journal, lease);
  await assert.rejects(dispatches.reserve(record(), modelRequest()), { code: "stop_requested" });
});
