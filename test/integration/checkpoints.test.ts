import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkflowRunState } from "@mastra/core/workflows";
import { GidorahBackend } from "../../src/backend.js";
import { databaseConfig } from "../../src/config.js";
import { FIXTURE_TARGET, fixtureConfig } from "../../src/foundation/contracts.js";
import { checkpointStore, initializeDatabase, type CheckpointStore } from "../../src/storage/bootstrap.js";
import { assertCheckpointFence } from "../../src/storage/checkpoint-fence.js";
import { PostgresJournal } from "../../src/storage/journal.js";

const connection = databaseConfig();
const journal = new PostgresJournal(connection);
const workflowName = "durable-agentic-loop";
before(async () => { await initializeDatabase(connection); });
after(async () => { await journal.close(); });

function snapshot(runId: string, marker: string): WorkflowRunState {
  return { runId, status: "running", context: {}, value: { marker }, activePaths: [], activeStepsPath: {}, suspendedPaths: {}, resumeLabels: {}, waitingPaths: {}, serializedStepGraph: [], timestamp: Date.now() };
}

async function save(checkpoint: CheckpointStore, runId: string, marker: string): Promise<void> {
  const workflows = await checkpoint.storage.getStore("workflows");
  assert.ok(workflows);
  await workflows.persistWorkflowSnapshot({ workflowName, runId, snapshot: snapshot(runId, marker) });
}

async function readMarker(runId: string): Promise<string | undefined> {
  const reader = checkpointStore(connection);
  try { return (await (await reader.storage.getStore("workflows"))?.loadWorkflowSnapshot({ workflowName, runId }))?.value.marker; }
  finally { await reader.end(); }
}

test("native checkpoints reject unowned writers and cross-run writes", async () => {
  const runId = randomUUID();
  const otherId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  await journal.createRun(otherId, FIXTURE_TARGET, fixtureConfig());
  const lease = await journal.acquire(runId);
  const writer = checkpointStore(connection, false, lease);
  const unowned = checkpointStore(connection);
  try {
    await save(writer, runId, "owned");
    await assert.rejects(save(unowned, runId, "unowned"), { code: "checkpoint_write_failed" });
    await assert.rejects(save(writer, otherId, "cross-run"), { code: "checkpoint_write_failed" });
    assert.equal(await readMarker(runId), "owned");
    assert.equal(await readMarker(otherId), undefined);
  } finally { await writer.end(); await unowned.end(); await journal.release(lease); }
});

test("an expired worker cannot update native snapshots through any native write API", async () => {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  const previous = await journal.acquire(runId, 300);
  const first = checkpointStore(connection, false, previous);
  try { await save(first, runId, "first"); }
  finally { await first.end(); }
  await sleep(350);
  const next = await journal.acquire(runId, 5000);
  const current = checkpointStore(connection, false, next);
  try {
    await save(current, runId, "new-owner");
    for (const operation of ["snapshot", "results", "state"] as const) {
      const stale = checkpointStore(connection, false, previous);
      try {
        const workflows = await stale.storage.getStore("workflows");
        assert.ok(workflows);
        const write = operation === "snapshot" ? save(stale, runId, "stale")
          : operation === "state" ? workflows.updateWorkflowState({ workflowName, runId, opts: { status: "success" } })
          : workflows.updateWorkflowResults({ workflowName, runId, stepId: "stale-step", result: { status: "success", output: {}, payload: {}, startedAt: Date.now(), endedAt: Date.now() }, requestContext: {} });
        await assert.rejects(write, { code: "checkpoint_write_failed" });
        assert.equal(stale.failureSignal.aborted, true);
        assert.throws(() => stale.assertHealthy(), { code: "checkpoint_write_failed" });
        assert.equal(await readMarker(runId), "new-owner");
      } finally { await stale.end(); }
    }
    await journal.heartbeat(next);
  } finally { await current.end(); await journal.release(next); }
});

test("checkpoint row locking serializes in-flight writes with ownership takeover", async () => {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  const previous = await journal.acquire(runId, 300);
  const writer = checkpointStore(connection, false, previous);
  const client = await writer.storage.pool.connect();
  let next;
  try {
    await client.query("BEGIN");
    await client.query('INSERT INTO gidorah_mastra_runtime.mastra_workflow_snapshot(workflow_name,run_id,snapshot,"createdAt","updatedAt") VALUES ($1,$2,$3,now(),now())', [workflowName, runId, JSON.stringify(snapshot(runId, "before-takeover"))]);
    await sleep(350);
    let claimed = false;
    const takeover = journal.acquire(runId, 5000).then((lease) => { claimed = true; return lease; });
    await sleep(100);
    assert.equal(claimed, false);
    await client.query("COMMIT");
    next = await takeover;
    assert.ok(next.epoch > previous.epoch);
    await assert.rejects(save(writer, runId, "late-write"), { code: "checkpoint_write_failed" });
    assert.equal(await readMarker(runId), "before-takeover");
  } finally {
    await client.query("ROLLBACK"); client.release(); await writer.end();
    if (next) await journal.release(next);
  }
});

test("terminal checkpoints cannot be overwritten, deleted or truncated", async () => {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  const lease = await journal.acquire(runId);
  const writer = checkpointStore(connection, false, lease);
  try {
    await save(writer, runId, "preserved");
    await journal.finish(lease, "stopped");
    await assert.rejects(save(writer, runId, "late-terminal"), { code: "checkpoint_write_failed" });
    const workflows = await writer.storage.getStore("workflows");
    assert.ok(workflows);
    await assert.rejects(workflows.deleteWorkflowRunById({ workflowName, runId }));
    await assert.rejects(writer.storage.pool.query("TRUNCATE gidorah_mastra_runtime.mastra_workflow_snapshot"));
    assert.equal(await readMarker(runId), "preserved");
  } finally { await writer.end(); await journal.release(lease); }
});

test("fence migration is repeatable and a disabled trigger prevents startup before allocation", async () => {
  await initializeDatabase(connection);
  await assertCheckpointFence(journal.pool);
  const backend = new GidorahBackend(connection);
  const handle = backend.run(FIXTURE_TARGET, fixtureConfig());
  try {
    await journal.pool.query("ALTER TABLE gidorah_mastra_runtime.mastra_workflow_snapshot DISABLE TRIGGER gidorah_checkpoint_write");
    const events = [];
    for await (const event of handle.events) events.push(event);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    await assert.rejects(journal.read(handle.runId), { code: "run_not_found" });
  } finally {
    await journal.pool.query("ALTER TABLE gidorah_mastra_runtime.mastra_workflow_snapshot ENABLE ALWAYS TRIGGER gidorah_checkpoint_write");
    await backend.close();
  }
});

test("wall deadline cancels a waiting tool without waiting for another dispatch", async () => {
  const backend = new GidorahBackend(connection, { fixtureHooks: { delayBeforeDispatchMs: 20000 } });
  const started = performance.now();
  try {
    const handle = backend.run(FIXTURE_TARGET, fixtureConfig({ capWallSec: 1 }));
    for await (const _event of handle.events) {}
    const run = await journal.read(handle.runId);
    assert.equal(run.terminal?.outcome, "stopped");
    assert.equal(run.terminal?.cleanupOk, true);
    assert.ok(performance.now() - started < 7000);
    const result = await journal.pool.query("SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1", [handle.runId]);
    assert.equal(result.rows[0].counter, 0);
  } finally { await backend.close(); }
});

test("startup fence verification rejects a trigger modified to skip writes", async () => {
  const client = await journal.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP TRIGGER gidorah_checkpoint_write ON gidorah_mastra_runtime.mastra_workflow_snapshot");
    await client.query("CREATE TRIGGER gidorah_checkpoint_write BEFORE INSERT OR UPDATE OR DELETE ON gidorah_mastra_runtime.mastra_workflow_snapshot FOR EACH ROW WHEN (false) EXECUTE FUNCTION gidorah_mastra.fence_native_checkpoint()");
    await client.query("ALTER TABLE gidorah_mastra_runtime.mastra_workflow_snapshot ENABLE ALWAYS TRIGGER gidorah_checkpoint_write");
    await assert.rejects(assertCheckpointFence(client), { code: "checkpoint_fence_unavailable" });
  } finally { await client.query("ROLLBACK"); client.release(); }
  await assertCheckpointFence(journal.pool);
});

test("a native storage failure cannot be hidden as successful runtime completion", async () => {
  const backend = new GidorahBackend(connection);
  const handle = backend.run(FIXTURE_TARGET, fixtureConfig());
  try {
    await journal.pool.query("CREATE FUNCTION gidorah_mastra.test_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_checkpoint_failure'; END; $$");
    await journal.pool.query(`CREATE TRIGGER test_checkpoint_failure BEFORE INSERT OR UPDATE ON gidorah_mastra_runtime.mastra_workflow_snapshot FOR EACH ROW WHEN (NEW.run_id = '${handle.runId}') EXECUTE FUNCTION gidorah_mastra.test_checkpoint_failure()`);
    const events = [];
    for await (const event of handle.events) events.push(event);
    assert.equal((await journal.read(handle.runId)).terminal?.outcome, "failed");
    assert.ok(events.some((event) => event.type === "error" && event.message.includes("checkpoint_write_failed")));
    assert.equal(events.filter((event) => event.type === "run.finished").length, 1);
    assert.equal((await journal.actions(handle.runId)).length, 0);
  } finally {
    await journal.pool.query("DROP TRIGGER IF EXISTS test_checkpoint_failure ON gidorah_mastra_runtime.mastra_workflow_snapshot");
    await journal.pool.query("DROP FUNCTION IF EXISTS gidorah_mastra.test_checkpoint_failure()");
    await backend.close();
  }
});

test("an active old runtime cannot finish or overwrite checkpoints after lease takeover", async () => {
  let next;
  let switched = false;
  const backend = new GidorahBackend(connection, { fixtureHooks: { at: async (point) => {
    if (point !== "after-model" || switched) return;
    switched = true;
    await journal.pool.query("UPDATE gidorah_mastra.runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [handle.runId]);
    next = await journal.acquire(handle.runId, 5000);
  } } });
  const handle = backend.run(FIXTURE_TARGET, fixtureConfig());
  try {
    await assert.rejects(async () => { for await (const _event of handle.events) {} }, { code: "lease_lost" });
    assert.equal((await journal.read(handle.runId)).terminal, undefined);
    assert.equal((await journal.actions(handle.runId)).length, 0);
    assert.ok(next);
    await journal.heartbeat(next);
    await journal.finish(next, "stopped");
  } finally { await backend.close(); if (next) await journal.release(next); }
});
