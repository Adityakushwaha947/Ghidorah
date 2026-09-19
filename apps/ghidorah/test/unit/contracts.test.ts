import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTRACT_VERSION,
  FIXTURE_TARGET,
  FixtureEventSchema,
  capsFor,
  fixtureConfig,
  validateFixtureRun,
} from "@ghidorah/foundation";
import { applyEvent } from "@ghidorah/foundation";
import { canonicalJson, digest } from "@ghidorah/foundation";
import { databaseConfig } from "../../src/config.js";
import { publicError } from "@ghidorah/foundation";

test("accepts only the explicitly registered development fixture", () => {
  assert.equal(validateFixtureRun(FIXTURE_TARGET, fixtureConfig()).model, "gidorah-fixture-v1");
  for (const target of ["https://example.com", "fixture://other", "http://169.254.169.254"]) {
    assert.throws(() => validateFixtureRun(target, fixtureConfig()), { code: "unsupported_profile" });
  }
});

test("rejects unsupported versions, budgets, capabilities, providers and approval profiles", () => {
  assert.throws(() => validateFixtureRun(FIXTURE_TARGET, { ...fixtureConfig(), contractVersion: "2.0.0" }), {
    code: "contract_version_mismatch",
  });
  for (const capUsd of [0, 1, undefined])
    assert.throws(() => validateFixtureRun(FIXTURE_TARGET, fixtureConfig({ capUsd })), { code: "unsupported_budget" });
  for (const capTokens of [NaN, Infinity, 0, -1, 0.5])
    assert.throws(() => validateFixtureRun(FIXTURE_TARGET, fixtureConfig({ capTokens })));
  assert.throws(() => validateFixtureRun(FIXTURE_TARGET, fixtureConfig({ capabilities: ["code"] })), {
    code: "unsupported_profile",
  });
  assert.throws(() => validateFixtureRun(FIXTURE_TARGET, fixtureConfig({ model: "paid-provider" })), {
    code: "unsupported_profile",
  });
  assert.throws(() => validateFixtureRun(FIXTURE_TARGET, fixtureConfig({ approvalProfile: "live-target" })), {
    code: "unsupported_profile",
  });
  assert.throws(
    () =>
      validateFixtureRun(
        FIXTURE_TARGET,
        fixtureConfig({ authorization: { asserted: true, scopeAllowlist: [FIXTURE_TARGET, "*"] } }),
      ),
    { code: "scope_denied" },
  );
});

test("snapshot boundary rejects stale redelivery and applies each later event once", () => {
  const runId = randomUUID();
  const caps = capsFor(fixtureConfig());
  const snapshot = {
    contractVersion: CONTRACT_VERSION,
    runId,
    seq: 4,
    type: "run.snapshot",
    target: FIXTURE_TARGET,
    mode: "pentest",
    capabilities: ["agentic_pentesting"],
    caps,
    spent: { tokens: 2, steps: 1, wallSec: 1 },
    findings: [],
    installDecisions: [],
    pendingApprovals: [],
    pendingReviews: [],
  };
  const state = applyEvent(undefined, snapshot);
  const stale = {
    contractVersion: CONTRACT_VERSION,
    runId,
    seq: 3,
    type: "budget",
    caps,
    spent: { tokens: 0, steps: 0, wallSec: 0 },
  };
  assert.equal(applyEvent(state, stale), state);
  const update = { ...stale, seq: 5, spent: { tokens: 4, steps: 2, wallSec: 2 } };
  const next = applyEvent(state, update);
  assert.equal(next.spent.tokens, 4);
  assert.equal(applyEvent(next, update), next);
  assert.throws(() => applyEvent(state, { ...update, seq: 6 }), { code: "event_gap" });
  assert.throws(() => applyEvent(state, { ...update, runId: randomUUID() }), { code: "run_mismatch" });
  assert.equal(applyEvent(next, snapshot).seq, 4);
});

test("unknown or unsupported finding events cannot masquerade as accepted fixture output", () => {
  assert.equal(
    FixtureEventSchema.safeParse({
      contractVersion: CONTRACT_VERSION,
      runId: randomUUID(),
      seq: 1,
      type: "finding.candidate",
      finding: { status: "confirmed" },
    }).success,
    false,
  );
});

test("canonical JSON is deterministic and rejects unsupported values", () => {
  assert.equal(
    digest({ target: 1, args: { second: 2, first: 1 } }),
    digest({ args: { first: 1, second: 2 }, target: 1 }),
  );
  for (const input of [undefined, Infinity, { missing: undefined }, new Date()])
    assert.throws(() => canonicalJson(input));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});

const remote = "postgresql://fixture-user:fixture-password@remote.invalid/fixture";

test("database configuration requires an explicit local profile and URL with no fallback", () => {
  const local = "postgresql://localhost:55432/gidorah";
  assert.throws(() => databaseConfig({ GIDORAH_DATABASE_URL: local }), { code: "database_config" });
  assert.throws(() => databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", DATABASE_URL: local }), {
    code: "database_config",
  });
  assert.throws(() => databaseConfig({ GIDORAH_DATABASE_PROFILE: "production", GIDORAH_DATABASE_URL: local }), {
    code: "database_config",
  });
  assert.equal(
    databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", GIDORAH_DATABASE_URL: local, DATABASE_URL: remote })
      .connectionString,
    local,
  );
});

test("local overrides cannot point at remote infrastructure", () => {
  for (const endpoint of [remote, "https://localhost/database", "invalid", "postgresql://localhost"])
    assert.throws(() => databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", GIDORAH_DATABASE_URL: endpoint }), {
      code: "database_config",
    });
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const connectionString = `postgresql://${host}:55432/gidorah`;
    assert.deepEqual(databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", GIDORAH_DATABASE_URL: connectionString }), {
      connectionString,
      ssl: false,
    });
  }
});

test("connection-string parameters and fragments cannot override the local profile", () => {
  for (const suffix of ["?host=remote.invalid", "?sslmode=require", "?options=unsafe", "#override"]) {
    assert.throws(
      () =>
        databaseConfig({
          GIDORAH_DATABASE_PROFILE: "local",
          GIDORAH_DATABASE_URL: `postgresql://localhost/gidorah${suffix}`,
        }),
      { code: "database_config" },
    );
  }
});

test("unexpected errors never reveal credential-bearing driver messages", () => {
  assert.equal(publicError(new Error(remote)).includes("fixture-password"), false);
});
