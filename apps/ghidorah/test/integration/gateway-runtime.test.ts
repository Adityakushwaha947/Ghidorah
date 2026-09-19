import assert from "node:assert/strict";
import { before, test } from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { CONTRACT_VERSION, FIXTURE_TARGET, fixtureConfig, type FixtureEvent } from "@ghidorah/foundation";
import { GidorahBackend } from "../../src/backend.js";
import { databaseConfig } from "../../src/config.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { PostgresJournal } from "../../src/storage/journal.js";
import { modelCounter } from "../helpers/model-counter.js";

const connection = databaseConfig();
const context = { contractVersion: CONTRACT_VERSION };
before(() => initializeDatabase(connection));

test("HTTP adapter to gateway to Mastra to journaled counter tools completes with actual mocked usage", async () => {
  const { profile, requests } = modelCounter();
  const backend = new GidorahBackend(connection, { modelProfile: profile });
  const events: FixtureEvent[] = [];
  try {
    const handle = backend.run(FIXTURE_TARGET, fixtureConfig({ model: profile.route.model, capTokens: 20000 }));
    for await (const event of handle.events) events.push(event);
    assert.equal((await backend.journal.read(handle.runId)).terminal?.outcome, "completed", JSON.stringify(events));
    assert.equal(requests.length, 3);
    assert.equal((await backend.journal.read(handle.runId)).spent.tokens, 48);
    assert.equal((await backend.journal.read(handle.runId)).spent.steps, 5);
    assert.equal((await backend.journal.actions(handle.runId)).length, 2);
    const counter = await backend.journal.pool.query(
      "SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1",
      [handle.runId],
    );
    assert.equal(counter.rows[0].counter, 1);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_event, index) => index + 1),
    );
    const replay: FixtureEvent[] = [];
    for await (const event of backend.recover(handle.runId, context).events) replay.push(event);
    assert.equal(replay.length, 1);
    assert.equal(replay[0]?.type, "run.snapshot");
    assert.equal(requests.length, 3);
    const unconfigured = new PostgresJournal(connection);
    try {
      await assert.rejects(unconfigured.read(handle.runId), { code: "runtime_version_mismatch" });
    } finally {
      await unconfigured.close();
    }
  } finally {
    await backend.close();
  }
});

test("provider refusal is charged, does not execute a tool and does not switch provider", async () => {
  const { profile, requests } = modelCounter({ mode: "refusal" });
  const backend = new GidorahBackend(connection, { modelProfile: profile });
  try {
    const handle = backend.run(FIXTURE_TARGET, fixtureConfig({ model: profile.route.model, capTokens: 20000 }));
    for await (const _event of handle.events) {
    }
    const run = await backend.journal.read(handle.runId);
    assert.equal(run.terminal?.outcome, "failed");
    assert.equal(run.spent.tokens, 16);
    assert.equal(requests.length, 1);
    assert.equal((await backend.journal.actions(handle.runId)).length, 0);
  } finally {
    await backend.close();
  }
});

test("a partial provider stream leaves durable uncertainty, not a fabricated terminal result", async () => {
  const { profile, requests } = modelCounter({ mode: "disconnect" });
  const backend = new GidorahBackend(connection, { modelProfile: profile });
  try {
    const handle = backend.run(FIXTURE_TARGET, fixtureConfig({ model: profile.route.model, capTokens: 20000 }));
    await assert.rejects(
      async () => {
        for await (const _event of handle.events) {
        }
      },
      { code: "uncertain_execution" },
    );
    assert.equal((await backend.journal.read(handle.runId)).terminal, undefined);
    assert.equal((await backend.journal.actions(handle.runId)).length, 0);
    const events: FixtureEvent[] = [];
    for await (const event of backend.recover(handle.runId, context).events) events.push(event);
    assert.equal(events[0]?.type, "error");
    assert.equal(requests.length, 1);
  } finally {
    await backend.close();
  }
});

test("real process kills reuse committed provider responses and tool results in the gateway-backed Mastra loop", async () => {
  for (const point of ["after-model", "after-result"]) {
    const child = spawn(
      process.execPath,
      [new URL("../helpers/gateway-crash-worker.ts", import.meta.url).pathname, point],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let diagnostic = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostic += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (_code, signal) => resolve(signal));
    }).finally(() => clearTimeout(timer));
    assert.equal(signal, "SIGKILL", diagnostic);
    const runId = /RUN:([0-9a-f-]+)/.exec(output)?.[1];
    assert.ok(runId, output);
    assert.equal(output.split("PROVIDER_DISPATCH").length - 1, 1);
    await sleep(1200);
    const { profile, requests } = modelCounter();
    const backend = new GidorahBackend(connection, { modelProfile: profile });
    try {
      const events: FixtureEvent[] = [];
      for await (const event of backend.recover(runId, context).events) events.push(event);
      const run = await backend.journal.read(runId);
      assert.equal(run.terminal?.outcome, "completed", JSON.stringify(events));
      assert.equal(requests.length, 2, "the first committed provider call is not repeated after recovery");
      assert.equal(run.spent.tokens, 48);
      const counter = await backend.journal.pool.query(
        "SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1",
        [runId],
      );
      assert.equal(counter.rows[0].counter, 1);
    } finally {
      await backend.close();
    }
  }
});
