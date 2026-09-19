import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FIXTURE_TARGET, fixtureConfig } from "@ghidorah/foundation";
import { FixtureApi } from "../../src/api/service.js";
import { tokenAuthenticator, type ApiPrincipal } from "../../src/api/auth.js";
import { initializeDatabase } from "../../src/storage/bootstrap.js";
import { databaseConfig } from "../../src/config.js";
import { GhidorahClient } from "../../../frontend/src/client.js";
import { modelCounter } from "../helpers/model-counter.js";

const connection = databaseConfig();
before(() => initializeDatabase(connection));
const ownerToken = "fixture_owner_".repeat(4);
const otherToken = "fixture_other_".repeat(4);
const readerToken = "fixture_reader_".repeat(4);
const principal: ApiPrincipal = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  engagementId: "engagement",
  policyRevision: "v1",
  permissions: ["run:create", "run:read", "run:control"],
  expiresAt: Date.now() + 600000,
};
const authenticate = tokenAuthenticator(
  [
    { token: ownerToken, principal },
    { token: otherToken, principal: { ...principal, tenantId: "tenant-b" } },
    { token: readerToken, principal: { ...principal, permissions: ["run:read" as const] } },
  ].map(({ token, principal }) => ({ tokenSha256: createHash("sha256").update(token).digest("hex"), principal })),
);

function request(path: string, token = ownerToken, method = "GET", body?: unknown, key = randomUUID()): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function client(api: FixtureApi, token = ownerToken): GhidorahClient {
  const transport: typeof fetch = (input, init) => api.fetch(new Request(input, init));
  return new GhidorahClient("http://localhost", () => token, transport);
}

test("authenticated API start is idempotent and a changed request cannot reuse its key", async () => {
  const api = new FixtureApi(connection, authenticate);
  try {
    const sdk = client(api);
    const key = randomUUID();
    const first = await sdk.start(FIXTURE_TARGET, fixtureConfig(), key);
    const second = await sdk.start(FIXTURE_TARGET, fixtureConfig(), key);
    assert.equal(first.runId, second.runId);
    const conflict = await api.fetch(
      request("/v1/runs", ownerToken, "POST", { target: FIXTURE_TARGET, config: fixtureConfig({ capSteps: 3 }) }, key),
    );
    assert.equal(conflict.status, 409);
    const events = [];
    for await (const event of sdk.events(first.runId)) events.push(event);
    assert.ok(events.at(-1)?.type === "run.finished" || events.at(-1)?.type === "run.snapshot");
    const snapshot = await sdk.snapshot(first.runId);
    assert.equal(snapshot.type === "run.snapshot" && snapshot.terminal?.outcome, "completed");
  } finally {
    await api.close();
  }
});

test("tenant isolation applies to snapshots, streams, controls and artifacts", async () => {
  const api = new FixtureApi(connection, authenticate);
  try {
    const created = await client(api).start(FIXTURE_TARGET, fixtureConfig(), randomUUID());
    for (const path of ["", "/events", `/artifacts?ref=sha256:${"0".repeat(64)}`])
      assert.equal((await api.fetch(request(`/v1/runs/${created.runId}${path}`, otherToken))).status, 404);
    assert.equal(
      (
        await api.fetch(
          request(`/v1/runs/${created.runId}/control`, otherToken, "POST", { contractVersion: "1.0.0", type: "stop" }),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await api.fetch(
          request(`/v1/runs/${created.runId}/control`, readerToken, "POST", { contractVersion: "1.0.0", type: "stop" }),
        )
      ).status,
      403,
    );
  } finally {
    await api.close();
  }
});

test("disconnecting the frontend does not cancel the separately supervised model run", async () => {
  const { profile } = modelCounter();
  const original = profile.route.client;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const gated = {
    ...profile,
    route: {
      ...profile.route,
      client: {
        seamVersion: original.seamVersion,
        complete: original.complete.bind(original),
        async *stream(...args: Parameters<typeof original.stream>) {
          if (++calls === 1) await gate;
          yield* original.stream(...args);
        },
      },
    },
  };
  const api = new FixtureApi(connection, authenticate, { modelProfile: gated, pollMs: 5 });
  const observer = new FixtureApi(connection, authenticate, { modelProfile: gated, pollMs: 5 });
  try {
    const sdk = client(api);
    const created = await sdk.start(
      FIXTURE_TARGET,
      fixtureConfig({ model: profile.route.model, capTokens: 20000 }),
      randomUUID(),
    );
    const stream = client(observer).events(created.runId);
    assert.equal((await stream.next()).value?.type, "run.snapshot");
    await stream.return(undefined);
    release();
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await sdk.snapshot(created.runId);
      if (snapshot.type === "run.snapshot" && snapshot.terminal) {
        assert.equal(snapshot.terminal.outcome, "completed");
        completed = true;
        break;
      }
      await sleep(20);
    }
    assert.equal(completed, true);
    assert.equal(calls, 3);
  } finally {
    release();
    await observer.close();
    await api.close();
  }
});

test("missing authentication, oversized bodies and forged authority fail before starting", async () => {
  const api = new FixtureApi(connection, authenticate);
  try {
    assert.equal((await api.fetch(new Request("http://localhost/v1/runs"))).status, 401);
    assert.equal(
      (
        await api.fetch(
          request("/v1/runs", ownerToken, "POST", {
            target: FIXTURE_TARGET,
            config: fixtureConfig(),
            tenantId: "other",
          }),
        )
      ).status,
      400,
    );
    assert.equal((await api.fetch(request("/v1/runs", ownerToken, "POST", { text: "x".repeat(65536) }))).status, 413);
    const browser = request("/v1/runs");
    browser.headers.set("origin", "https://unapproved.invalid");
    assert.equal((await api.fetch(browser)).status, 403);
  } finally {
    await api.close();
  }
});

test("loopback HTTP server and frontend client complete an authenticated fixture run", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  const child = spawn(process.execPath, [new URL("../../src/api/server.ts", import.meta.url).pathname], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GIDORAH_API_PORT: String(port),
      GIDORAH_API_TOKENS_JSON: JSON.stringify([
        { tokenSha256: createHash("sha256").update(ownerToken).digest("hex"), principal },
      ]),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostic = "";
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture API startup timed out.")), 10000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(diagnostic));
      });
      child.stderr.on("data", (chunk) => {
        diagnostic += String(chunk);
        if (diagnostic.includes("Authenticated counter-fixture API")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const sdk = new GhidorahClient(`http://127.0.0.1:${port}`, () => ownerToken);
    const run = await sdk.start(FIXTURE_TARGET, fixtureConfig(), randomUUID());
    for await (const _event of sdk.events(run.runId)) {
    }
    const snapshot = await sdk.snapshot(run.runId);
    assert.equal(snapshot.type === "run.snapshot" && snapshot.terminal?.outcome, "completed");
    assert.ok(!diagnostic.includes(ownerToken));
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited.finally(() => clearTimeout(timer));
  }
});
