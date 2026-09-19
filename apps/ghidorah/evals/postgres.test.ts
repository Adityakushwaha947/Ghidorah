import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GidorahBackend } from "../src/backend.js";
import { databaseConfig } from "../src/config.js";
import { FixtureExecutor } from "../src/execution/fixture-executor.js";
import {
  CONTRACT_VERSION,
  FIXTURE_TARGET,
  RUNTIME_VERSION,
  fixtureConfig,
  type AgentControl,
  type FixtureEvent,
  type RunConfig,
} from "@ghidorah/foundation";
import { PostgresJournal, type Lease } from "../src/storage/journal.js";
import { initializeDatabase } from "../src/storage/bootstrap.js";
import { evaluationSuite } from "./register.js";

const suite = evaluationSuite("postgres");
const connection = databaseConfig();
const journal = new PostgresJournal(connection);
const context = { contractVersion: CONTRACT_VERSION };
const pendingRequest = { messages: [{ role: "user", content: "synthetic journal evaluation" }] };

before(async () => {
  await initializeDatabase(connection);
});
after(async () => {
  await journal.close();
});

async function withRun(verify: (lease: Lease) => Promise<void>, overrides: Partial<RunConfig> = {}): Promise<void> {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig(overrides));
  const lease = await journal.acquire(runId, 60000);
  try {
    await verify(lease);
  } finally {
    await journal.finish(lease, "stopped").catch(() => undefined);
    await journal.release(lease);
  }
}

async function proposal(lease: Lease, calls = [{ id: "first", name: "fixture_increment", args: {} }]): Promise<void> {
  await journal.beginModel(lease, "proposal", pendingRequest);
  await journal.completeModel(lease, "proposal", {
    id: "fixture-proposal",
    content: "Synthetic journal test, not a provider response.",
    tool_calls: calls.map((call) => ({ ...call, type: "tool_call" })),
    usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

async function prepared(lease: Lease): Promise<void> {
  await proposal(lease);
  await journal.prepareAction(lease, "first", "fixture_increment", {});
}

async function counter(runId: string): Promise<number> {
  return (await journal.pool.query("SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1", [runId]))
    .rows[0].counter;
}

async function assertNoAdditionalSpend(
  runId: string,
  previous: { seq: number; spent: { steps: number; tokens: number } },
): Promise<void> {
  const current = await journal.read(runId);
  assert.equal(current.seq, previous.seq);
  assert.equal(current.spent.steps, previous.spent.steps);
  assert.equal(current.spent.tokens, previous.spent.tokens);
}

suite.check("GID-071", async () => {
  await withRun(async (lease) => {
    const run = await journal.read(lease.runId);
    const events = await journal.eventsAfter(lease.runId, 0);
    assert.equal(run.seq, 1);
    assert.equal(run.spent.steps, 0);
    assert.equal(run.spent.tokens, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "run.started");
    assert.equal(events[0]?.seq, run.seq);
    assert.equal(await counter(lease.runId), 0);
  });
});
suite.check("GID-072", async () => {
  const runId = randomUUID();
  await assert.rejects(journal.createRun(runId, "fixture://unregistered", fixtureConfig()), {
    code: "unsupported_profile",
  });
  for (const table of ["runs", "events", "fixture_targets"]) {
    const idColumn = table === "runs" ? "id" : "run_id";
    const rows = await journal.pool.query(`SELECT 1 FROM gidorah_mastra.${table} WHERE ${idColumn}=$1`, [runId]);
    assert.equal(rows.rowCount, 0);
  }
});
suite.check("GID-073", async () => {
  await withRun(async (lease) => {
    const before = await journal.read(lease.runId);
    await assert.rejects(journal.createRun(lease.runId, FIXTURE_TARGET, fixtureConfig()), { code: "23505" });
    await assertNoAdditionalSpend(lease.runId, before);
    assert.equal(await counter(lease.runId), 0);
  });
});
suite.check("GID-074", async () => {
  await assert.rejects(journal.read(randomUUID()), { code: "run_not_found" });
});
suite.check("GID-075", async () => {
  await withRun(async (lease) => {
    await journal.pool.query("UPDATE gidorah_mastra.runs SET runtime_version='incompatible' WHERE id=$1", [
      lease.runId,
    ]);
    try {
      await assert.rejects(journal.read(lease.runId), { code: "runtime_version_mismatch" });
    } finally {
      await journal.pool.query("UPDATE gidorah_mastra.runs SET runtime_version=$2 WHERE id=$1", [
        lease.runId,
        RUNTIME_VERSION,
      ]);
    }
    assert.equal((await journal.read(lease.runId)).seq, 1);
  });
});
suite.check("GID-076", async () => {
  await withRun(async (lease) => {
    await journal.pool.query(
      "UPDATE gidorah_mastra.runs SET config=jsonb_set(config,'{contractVersion}','\"2.0.0\"') WHERE id=$1",
      [lease.runId],
    );
    try {
      await assert.rejects(journal.read(lease.runId), { code: "contract_version_mismatch" });
    } finally {
      await journal.pool.query("UPDATE gidorah_mastra.runs SET config=$2 WHERE id=$1", [lease.runId, fixtureConfig()]);
    }
    assert.equal((await journal.read(lease.runId)).seq, 1);
  });
});
suite.check("GID-077", async () => {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  for (const ttl of [199, 60001, 500.5]) await assert.rejects(journal.acquire(runId, ttl), { code: "invalid_lease" });
  const lease = await journal.acquire(runId);
  await journal.finish(lease, "stopped");
  await journal.release(lease);
});
suite.check("GID-078", async () => {
  const runId = randomUUID();
  await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig());
  const old = await journal.acquire(runId, 200);
  await sleep(250);
  const next = await journal.acquire(runId, 60000);
  try {
    assert.ok(next.epoch > old.epoch);
    await assert.rejects(journal.dispatchAction(old, "first"), { code: "lease_lost" });
    await assert.rejects(journal.fixtureEffect(old, "first", "fixture_increment"), { code: "lease_lost" });
    assert.equal(await counter(runId), 0);
    await journal.heartbeat(next);
  } finally {
    await journal.finish(next, "stopped");
    await journal.release(next);
  }
});
suite.check("GID-079", async () => {
  await withRun(async (first) => {
    await withRun(async (second) => {
      await assert.rejects(journal.beginModel({ ...first, runId: second.runId }, "forged", pendingRequest), {
        code: "lease_lost",
      });
      assert.equal((await journal.read(second.runId)).spent.steps, 0);
    });
  });
});
suite.check("GID-080", async () => {
  await withRun(
    async (lease) => {
      await journal.pool.query(
        "UPDATE gidorah_mastra.runs SET started_at=clock_timestamp()-interval '2 seconds' WHERE id=$1",
        [lease.runId],
      );
      await assert.rejects(journal.beginModel(lease, "late", pendingRequest), { code: "budget_exhausted" });
      assert.equal((await journal.read(lease.runId)).spent.steps, 0);
    },
    { capWallSec: 1 },
  );
});
suite.check("GID-081", async () => {
  await withRun(async (lease) => {
    assert.equal(await journal.beginModel(lease, "first", pendingRequest), undefined);
    const run = await journal.read(lease.runId);
    assert.equal(run.spent.steps, 1);
    assert.equal(run.spent.tokens, 2);
    assert.equal(
      (await journal.pool.query("SELECT state FROM gidorah_mastra.model_calls WHERE run_id=$1", [lease.runId])).rows[0]
        .state,
      "dispatched",
    );
  });
});
suite.check("GID-082", async () => {
  await withRun(async (lease) => {
    await proposal(lease);
    const before = await journal.read(lease.runId);
    const stored = (
      await journal.pool.query("SELECT response FROM gidorah_mastra.model_calls WHERE run_id=$1", [lease.runId])
    ).rows[0].response;
    assert.deepEqual(await journal.beginModel(lease, "proposal", pendingRequest), stored);
    await assertNoAdditionalSpend(lease.runId, before);
  });
});
suite.check("GID-083", async () => {
  await withRun(async (lease) => {
    await proposal(lease);
    const before = await journal.read(lease.runId);
    await assert.rejects(journal.beginModel(lease, "proposal", { changed: true }), { code: "replay_mismatch" });
    await assertNoAdditionalSpend(lease.runId, before);
  });
});
suite.check("GID-084", async () => {
  await withRun(async (lease) => {
    await journal.beginModel(lease, "pending", pendingRequest);
    const before = await journal.read(lease.runId);
    await assert.rejects(journal.beginModel(lease, "pending", pendingRequest), { code: "uncertain_execution" });
    await assertNoAdditionalSpend(lease.runId, before);
  });
});
suite.check("GID-085", async () => {
  await withRun(async (lease) => {
    await journal.beginModel(lease, "pending", pendingRequest);
    const before = await journal.read(lease.runId);
    await assert.rejects(journal.beginModel(lease, "replacement", pendingRequest), { code: "uncertain_execution" });
    await assertNoAdditionalSpend(lease.runId, before);
    assert.equal(
      (await journal.pool.query("SELECT 1 FROM gidorah_mastra.model_calls WHERE run_id=$1", [lease.runId])).rowCount,
      1,
    );
  });
});
suite.check("GID-086", async () => {
  await withRun(async (lease) => {
    await assert.rejects(journal.completeModel(lease, "absent", {}), { code: "invalid_transition" });
    assert.equal(
      (await journal.pool.query("SELECT 1 FROM gidorah_mastra.model_calls WHERE run_id=$1", [lease.runId])).rowCount,
      0,
    );
  });
});
suite.check("GID-087", async () => {
  await withRun(async (lease) => {
    await assert.rejects(journal.prepareAction(lease, "first", "fixture_increment", {}), { code: "unrecorded_action" });
    assert.equal((await journal.actions(lease.runId)).length, 0);
    assert.equal((await journal.read(lease.runId)).spent.steps, 0);
  });
});
suite.check("GID-088", async () => {
  await withRun(async (lease) => {
    await proposal(lease);
    await assert.rejects(journal.prepareAction(lease, "first", "fixture_increment", { changed: true }), {
      code: "unrecorded_action",
    });
    assert.equal((await journal.actions(lease.runId)).length, 0);
  });
});
suite.check("GID-089", async () => {
  await withRun(async (lease) => {
    await prepared(lease);
    const before = await journal.read(lease.runId);
    assert.equal(await journal.prepareAction(lease, "first", "fixture_increment", {}), undefined);
    await assertNoAdditionalSpend(lease.runId, before);
    assert.equal((await journal.actions(lease.runId)).length, 1);
  });
});
suite.check("GID-090", async () => {
  await withRun(async (lease) => {
    await assert.rejects(journal.dispatchAction(lease, "missing"), { code: "invalid_transition" });
    await prepared(lease);
    await journal.dispatchAction(lease, "first");
    await assert.rejects(journal.dispatchAction(lease, "first"), { code: "invalid_transition" });
    assert.equal(await counter(lease.runId), 0);
  });
});
suite.check("GID-091", async () => {
  await withRun(async (lease) => {
    await prepared(lease);
    const before = await journal.read(lease.runId);
    await assert.rejects(journal.prepareAction(lease, "first", "fixture_read", {}), { code: "replay_mismatch" });
    await assert.rejects(journal.prepareAction(lease, "first", "fixture_increment", { changed: true }), {
      code: "replay_mismatch",
    });
    await assertNoAdditionalSpend(lease.runId, before);
  });
});
suite.check("GID-092", async () => {
  await withRun(async (lease) => {
    await proposal(lease, [
      { id: "first", name: "fixture_increment", args: {} },
      { id: "second", name: "fixture_read", args: {} },
    ]);
    await journal.prepareAction(lease, "first", "fixture_increment", {});
    const before = await journal.read(lease.runId);
    await assert.rejects(journal.prepareAction(lease, "second", "fixture_read", {}), { code: "action_in_progress" });
    await assertNoAdditionalSpend(lease.runId, before);
  });
});
suite.check("GID-093", async () => {
  await withRun(async (lease) => {
    await prepared(lease);
    await journal.dispatchAction(lease, "first");
    await assert.rejects(journal.fixtureEffect(lease, "first", "fixture_read"), { code: "dispatch_denied" });
    assert.equal(await counter(lease.runId), 0);
  });
});
suite.check("GID-094", async () => {
  await withRun(async (lease) => {
    await prepared(lease);
    await journal.dispatchAction(lease, "first");
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(journal.completeAction(lease, "first", value), { code: "invalid_artifact" });
    assert.equal(
      (await journal.pool.query("SELECT 1 FROM gidorah_mastra.artifacts WHERE run_id=$1", [lease.runId])).rowCount,
      0,
    );
    assert.equal((await journal.actions(lease.runId))[0]?.state, "dispatched");
  });
});
suite.check("GID-095", async () => {
  await withRun(async (lease) => {
    await prepared(lease);
    await journal.dispatchAction(lease, "first");
    const result = await journal.fixtureEffect(lease, "first", "fixture_increment");
    const ref = await journal.completeAction(lease, "first", result.counter);
    const before = await journal.read(lease.runId);
    await assert.rejects(journal.completeAction(lease, "first", 2), { code: "invalid_transition" });
    await assertNoAdditionalSpend(lease.runId, before);
    assert.equal((await journal.actions(lease.runId))[0]?.artifactRef, ref);
    assert.equal((await journal.eventsAfter(lease.runId, 0)).filter((event) => event.type === "tool.result").length, 1);
    assert.equal(
      (await journal.pool.query("SELECT 1 FROM gidorah_mastra.artifacts WHERE run_id=$1", [lease.runId])).rowCount,
      1,
    );
    assert.deepEqual(JSON.parse((await journal.artifact(lease.runId, ref)).bytes), { counter: 1 });
  });
});
suite.check("GID-096", async () => {
  await withRun(async (lease) => {
    await proposal(lease);
    const executor = new FixtureExecutor(journal, lease, new AbortController().signal);
    const first = await executor.execute("first", "fixture_increment", {});
    const before = await journal.read(lease.runId);
    assert.equal(await executor.execute("first", "fixture_increment", {}), first);
    await assertNoAdditionalSpend(lease.runId, before);
    assert.equal(await counter(lease.runId), 1);
  });
});
suite.check("GID-097", async () => {
  await withRun(async (source) => {
    await prepared(source);
    await journal.dispatchAction(source, "first");
    const result = await journal.fixtureEffect(source, "first", "fixture_increment");
    const ref = await journal.completeAction(source, "first", result.counter);
    await withRun(async (other) => {
      await assert.rejects(journal.artifact(other.runId, ref), { code: "evidence_integrity" });
    });
  });
});
suite.check("GID-098", async () => {
  await withRun(async (lease) => {
    await journal.beginModel(lease, "pending", pendingRequest);
    await assert.rejects(journal.finish(lease, "completed"), { code: "uncertain_execution" });
    assert.equal((await journal.read(lease.runId)).terminal, undefined);
    await journal.finish(lease, "failed", "Synthetic pending model dispatch.");
    assert.deepEqual((await journal.read(lease.runId)).terminal, { outcome: "failed", cleanupOk: false });
  });
});
suite.check("GID-099", async () => {
  const backend = new GidorahBackend(connection);
  try {
    const handle = backend.run(FIXTURE_TARGET, fixtureConfig());
    const controls: AgentControl[] = [
      { ...context, type: "pause" },
      { ...context, type: "resume" },
      { ...context, type: "approve", approvalId: "approval", decision: "allow" },
      {
        ...context,
        type: "review",
        reviewRequestId: "review",
        findingId: "finding",
        evidenceRev: "revision",
        reason: "checked",
        decision: "confirm",
      },
    ];
    for (const control of controls) assert.throws(() => handle.control(control), { code: "unsupported_control" });
    await assert.rejects(journal.read(handle.runId), { code: "run_not_found" });
  } finally {
    await backend.close();
  }
});
suite.check("GID-100", async () => {
  const backend = new GidorahBackend(connection);
  try {
    const handle = backend.run(FIXTURE_TARGET, fixtureConfig({ capTokens: 1 }));
    const events: FixtureEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const run = await journal.read(handle.runId);
    assert.equal(run.terminal?.outcome, "stopped");
    assert.equal(run.spent.steps, 0);
    assert.equal(run.spent.tokens, 0);
    assert.equal(events.filter((event) => event.type === "run.finished").length, 1);
    assert.equal((await journal.actions(handle.runId)).length, 0);
    assert.equal(await counter(handle.runId), 0);
    assert.equal(
      (await journal.pool.query("SELECT 1 FROM gidorah_mastra.model_calls WHERE run_id=$1", [handle.runId])).rowCount,
      0,
    );
  } finally {
    await backend.close();
  }
});

suite.seal();
