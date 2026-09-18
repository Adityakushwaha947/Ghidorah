import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { GidorahBackend } from "../../src/backend.js";
import { databaseConfig } from "../../src/config.js";
import { CONTRACT_VERSION, FIXTURE_TARGET, fixtureConfig, type FixtureEvent, type RunHandle } from "../../src/foundation/contracts.js";
import { checkpointStore, initializeDatabase } from "../../src/storage/bootstrap.js";
import { PostgresJournal } from "../../src/storage/journal.js";
import { FixtureExecutor } from "../../src/execution/fixture-executor.js";

const connection = databaseConfig();
const journal = new PostgresJournal(connection);
const context = { contractVersion: CONTRACT_VERSION };

before(async () => { await initializeDatabase(connection); });
after(async () => { await journal.close(); });

async function collect(handle: RunHandle): Promise<FixtureEvent[]> {
  const events: FixtureEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

async function crashAt(point: string): Promise<string> {
  const child = spawn(process.execPath, ["--import", "tsx", "test/helpers/crash-worker.ts", point], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let diagnostic = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostic += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(result.signal, "SIGKILL", `Expected an actual process kill: ${diagnostic}\n${output}`);
  const lines = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(lines.some((line) => line.faultPoint === point), `The requested crash boundary was not reached: ${output}`);
  const runId: string = lines.find((line) => line.runId)?.runId;
  assert.ok(runId);
  await sleep(3300);
  return runId;
}

test("pre-start rejection creates no run records", async () => {
  const backend = new GidorahBackend(connection);
  try {
    const beforeCount = await journal.pool.query("SELECT count(*)::int AS total FROM gidorah_mastra.runs");
    assert.throws(() => backend.run("https://unregistered.invalid", fixtureConfig()));
    const afterCount = await journal.pool.query("SELECT count(*)::int AS total FROM gidorah_mastra.runs");
    assert.equal(afterCount.rows[0].total, beforeCount.rows[0].total);
  } finally { await backend.close(); }
});

test("real Mastra loop commits ordered events, artifacts, checkpoints and one terminal result", async () => {
  const checkpoint = checkpointStore(connection);
  let handle: RunHandle;
  let persistedWhileRunning = false;
  const backend = new GidorahBackend(connection, { fixtureHooks: { at: async (point) => {
    if (point !== "after-model") return;
    const store = await checkpoint.storage.getStore("workflows");
    const snapshot = await store?.loadWorkflowSnapshot({ workflowName: "durable-agentic-loop", runId: handle.runId });
    assert.ok(snapshot);
    assert.equal(snapshot.status, "running");
    persistedWhileRunning = true;
  } } });
  try {
    handle = backend.run(FIXTURE_TARGET, fixtureConfig());
    const events = await collect(handle);
    assert.equal(events[0]?.type, "run.started");
    assert.equal(events.filter((event) => event.type === "run.finished").length, 1);
    assert.equal(events.at(-1)?.type, "run.finished", JSON.stringify(events));
    const run = await journal.read(handle.runId);
    assert.equal(run.terminal?.outcome, "completed", JSON.stringify(events));
    assert.equal(run.spent.steps, 5);
    assert.equal(run.spent.tokens, 6);
    assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1));
    const result = events.find((event) => event.type === "tool.result");
    assert.ok(result?.type === "tool.result");
    assert.equal(JSON.parse((await backend.getArtifact(handle.runId, result.artifactRef, context)).bytes).counter, 1);
    assert.ok(persistedWhileRunning);
    const recovered = await collect(backend.recover(handle.runId, context));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.type, "run.snapshot");
    assert.equal((await journal.read(handle.runId)).spent.wallSec, run.spent.wallSec);
    await assert.rejects(backend.getArtifact(randomUUID(), result.artifactRef, context), { code: "run_not_found" });
  } finally { await backend.close(); await checkpoint.end(); }
});

test("recovery after model, intent and result commits does not duplicate the fixture effect", async () => {
  for (const boundary of ["after-model", "after-intent", "after-result"]) {
    const runId = await crashAt(boundary);
    const backend = new GidorahBackend(connection);
    try {
      const before = await journal.read(runId);
      const events = await collect(backend.recover(runId, context));
      assert.equal(events[0]?.type, "run.snapshot", JSON.stringify(events));
      assert.equal(events[0]?.seq, before.seq);
      const run = await journal.read(runId);
      assert.equal(run.terminal?.outcome, "completed", JSON.stringify(events));
      assert.equal(run.spent.steps, 5);
      assert.equal(run.spent.tokens, 6);
      const counter = await journal.pool.query("SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1", [runId]);
      assert.equal(counter.rows[0].counter, 1);
      assert.ok(events.slice(1).every((event) => event.seq > before.seq));
    } finally { await backend.close(); }
  }
});

test("real kills after dispatch and effect commits block blind recovery", async () => {
  for (const boundary of ["after-dispatch", "after-effect"]) {
    const runId = await crashAt(boundary);
    const backend = new GidorahBackend(connection);
    try {
      const before = await journal.read(runId);
      const events = await collect(backend.recover(runId, context));
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "error");
      assert.ok(events[0]?.type === "error" && events[0].message.includes("uncertain_execution"));
      const after = await journal.read(runId);
      assert.equal(after.terminal, undefined);
      assert.equal(after.seq, before.seq);
      assert.equal(after.spent.steps, before.spent.steps);
      assert.equal(after.spent.tokens, before.spent.tokens);
      const counter = await journal.pool.query("SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1", [runId]);
      assert.equal(counter.rows[0].counter, boundary === "after-effect" ? 1 : 0);
    } finally { await backend.close(); }
  }
});

test("run leases fence previous owners and competing claims", async () => {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  const claims = await Promise.allSettled([journal.acquire(runId, 1000), journal.acquire(runId, 1000)]);
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  const previous = claims.find((claim) => claim.status === "fulfilled");
  assert.ok(previous?.status === "fulfilled");
  await sleep(1100);
  const next = await journal.acquire(runId, 5000);
  assert.ok(next.epoch > previous.value.epoch);
  await assert.rejects(journal.beginModel(previous.value, "old", {}), { code: "lease_lost" });
  await assert.rejects(journal.heartbeat(previous.value), { code: "lease_lost" });
  await journal.release(previous.value);
  await journal.heartbeat(next);
  await journal.finish(next, "stopped");
  await journal.release(next);
});

test("budget limits stop before extra dispatch; requested stop cancels a pending fixture wait", async () => {
  const capped = new GidorahBackend(connection);
  try {
    const handle = capped.run(FIXTURE_TARGET, fixtureConfig({ capSteps: 1 }));
    const events = await collect(handle);
    assert.equal((await journal.read(handle.runId)).terminal?.outcome, "stopped", JSON.stringify(events));
    assert.equal((await journal.actions(handle.runId)).length, 0);
  } finally { await capped.close(); }
  const stopped = new GidorahBackend(connection, { fixtureHooks: { delayBeforeDispatchMs: 10000 } });
  try {
    const handle = stopped.run(FIXTURE_TARGET, fixtureConfig());
    const events: FixtureEvent[] = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === "tool.call") handle.control({ ...context, type: "stop" });
    }
    assert.equal((await journal.read(handle.runId)).terminal?.outcome, "stopped", JSON.stringify(events));
    assert.equal(events.filter((event) => event.type === "run.finished").length, 1);
    const counter = await journal.pool.query("SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1", [handle.runId]);
    assert.equal(counter.rows[0].counter, 0);
  } finally { await stopped.close(); }
});

test("artifact tampering blocks completed-action replay", async () => {
  const runId = await crashAt("after-result");
  const actions = await journal.actions(runId);
  const ref = actions[0]?.artifactRef;
  assert.ok(ref);
  await journal.pool.query("UPDATE gidorah_mastra.artifacts SET bytes='tampered fixture' WHERE run_id=$1 AND ref=$2", [runId, ref]);
  const backend = new GidorahBackend(connection);
  try {
    const events = await collect(backend.recover(runId, context));
    assert.equal((await journal.read(runId)).terminal?.outcome, "failed", JSON.stringify(events));
    assert.ok(events.some((event) => event.type === "error" && event.message.includes("evidence_integrity")));
    const counter = await journal.pool.query("SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1", [runId]);
    assert.equal(counter.rows[0].counter, 1);
  } finally { await backend.close(); }
});

test("executor rejects unregistered tools and unrecorded proposals", async () => {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  const lease = await journal.acquire(runId);
  const executor = new FixtureExecutor(journal, lease, new AbortController().signal);
  try {
    await assert.rejects(executor.execute("made-up", "bash", { command: "echo denied" }), { code: "tool_denied" });
    await assert.rejects(executor.execute("made-up", "fixture_increment", {}), { code: "unrecorded_action" });
    assert.equal((await journal.actions(runId)).length, 0);
    await journal.finish(lease, "stopped");
  } finally { await journal.release(lease); }
});

test("in-process observers receive the terminal event without a snapshot/live gap", async () => {
  const backend = new GidorahBackend(connection);
  try {
    const handle = backend.run(FIXTURE_TARGET, fixtureConfig());
    const iterator = handle.events[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "run.started");
    const observer = backend.observe(handle.runId, context);
    const initial = await observer.next();
    assert.equal(initial.value?.type, "run.snapshot");
    const execution = (async () => { while (!(await iterator.next()).done) {} })();
    const observed: FixtureEvent[] = [];
    for await (const event of observer) observed.push(event);
    await execution;
    assert.equal(observed.at(-1)?.type, "run.finished");
    assert.equal(observed.filter((event) => event.type === "run.finished").length, 1);
  } finally { await backend.close(); }
});

test("closing a backend releases an initialized but unconsumed execution handle", async () => {
  const backend = new GidorahBackend(connection);
  const handle = backend.run(FIXTURE_TARGET, fixtureConfig());
  const iterator = handle.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "run.started");
  await backend.close();
  const run = await journal.read(handle.runId);
  assert.equal(run.terminal?.outcome, "stopped");
  assert.equal((await journal.actions(handle.runId)).length, 0);
});
