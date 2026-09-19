import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AgentControlSchema,
  CONTRACT_VERSION,
  ContractContextSchema,
  FIXTURE_MODEL,
  FIXTURE_TARGET,
  FixtureEventSchema,
  capsFor,
  fixtureConfig,
  validateFixtureRun,
} from "@ghidorah/foundation";
import { canonicalJson, digest, sha256 } from "@ghidorah/foundation";
import { applyEvent } from "@ghidorah/foundation";
import { databaseConfig } from "../src/config.js";
import { publicError } from "@ghidorah/foundation";
import { evaluationSuite } from "./register.js";

const suite = evaluationSuite("unit");
const runId = randomUUID();
const caps = capsFor(fixtureConfig());
const envelope = { contractVersion: CONTRACT_VERSION, runId };
const start = {
  ...envelope,
  seq: 1,
  type: "run.started",
  target: FIXTURE_TARGET,
  mode: "pentest",
  capabilities: ["agentic_pentesting"],
  caps,
};
const budget = { ...envelope, seq: 2, type: "budget", caps, spent: { tokens: 2, steps: 1, wallSec: 1 } };
const snapshot = {
  ...start,
  seq: 4,
  type: "run.snapshot",
  spent: budget.spent,
  findings: [],
  installDecisions: [],
  pendingApprovals: [],
  pendingReviews: [],
};
const finished = {
  ...envelope,
  seq: 2,
  type: "run.finished",
  outcome: "completed",
  cleanupOk: true,
  confirmed: 0,
  needsHuman: 0,
  discarded: 0,
  reportPath: "fixture-report",
};
const remote = "postgresql://fixture-user:fixture-password@remote.invalid/fixture";

function rejectsConfig(overrides: Record<string, unknown>, code: string): void {
  assert.throws(() => validateFixtureRun(FIXTURE_TARGET, { ...fixtureConfig(), ...overrides }), { code });
}

suite.check("GID-001", () => {
  assert.equal(validateFixtureRun(FIXTURE_TARGET, fixtureConfig()).model, FIXTURE_MODEL);
});
suite.check("GID-002", () => {
  assert.equal(validateFixtureRun(FIXTURE_TARGET, fixtureConfig({ capabilities: undefined })).capabilities, undefined);
});
suite.check("GID-003", () => {
  rejectsConfig({ contractVersion: undefined }, "contract_version_mismatch");
});
suite.check("GID-004", () => {
  rejectsConfig({ contractVersion: "2.0.0" }, "contract_version_mismatch");
});
suite.check("GID-005", () => {
  assert.throws(() => validateFixtureRun(FIXTURE_TARGET, null), { code: "contract_version_mismatch" });
});
suite.check("GID-006", () => {
  rejectsConfig({ autoApprove: true }, "invalid_config");
});
suite.check("GID-007", () => {
  rejectsConfig({ capUsd: 0 }, "unsupported_budget");
});
suite.check("GID-008", () => {
  rejectsConfig({ capUsd: 1 }, "unsupported_budget");
});
suite.check("GID-009", () => {
  rejectsConfig({ capUsd: undefined }, "unsupported_budget");
});
suite.check("GID-010", () => {
  rejectsConfig({ capTokens: undefined }, "invalid_config");
});
suite.check("GID-011", () => {
  rejectsConfig({ capTokens: 0 }, "invalid_config");
});
suite.check("GID-012", () => {
  rejectsConfig({ capSteps: -1 }, "invalid_config");
});
suite.check("GID-013", () => {
  rejectsConfig({ capWallSec: 1.5 }, "invalid_config");
});
suite.check("GID-014", () => {
  rejectsConfig({ capTokens: NaN }, "invalid_config");
});
suite.check("GID-015", () => {
  rejectsConfig({ capSteps: Infinity }, "invalid_config");
});
suite.check("GID-016", () => {
  rejectsConfig({ capWallSec: 2_147_483_648 }, "invalid_config");
});
suite.check("GID-017", () => {
  rejectsConfig({ capabilities: [] }, "invalid_config");
});
suite.check("GID-018", () => {
  rejectsConfig({ capabilities: ["invented"] }, "invalid_config");
});
suite.check("GID-019", () => {
  rejectsConfig({ capabilities: ["code"] }, "unsupported_profile");
});
suite.check("GID-020", () => {
  rejectsConfig({ capabilities: ["agentic_pentesting", "secrets"] }, "unsupported_profile");
});
suite.check("GID-021", () => {
  rejectsConfig({ model: undefined }, "unsupported_profile");
});
suite.check("GID-022", () => {
  rejectsConfig({ model: "paid-provider" }, "unsupported_profile");
});
suite.check("GID-023", () => {
  rejectsConfig({ approvalProfile: "live-target" }, "unsupported_profile");
});
suite.check("GID-024", () => {
  rejectsConfig({ targetKind: "repo" }, "unsupported_profile");
});
suite.check("GID-025", () => {
  rejectsConfig(
    { change: { repository: "fixture", baseRevision: "base", headRevision: "head" } },
    "unsupported_profile",
  );
});
suite.check("GID-026", () => {
  assert.throws(() => validateFixtureRun("https://example.invalid", fixtureConfig()), { code: "unsupported_profile" });
});
suite.check("GID-027", () => {
  rejectsConfig({ authorization: { asserted: false, scopeAllowlist: [FIXTURE_TARGET] } }, "scope_denied");
});
suite.check("GID-028", () => {
  rejectsConfig({ authorization: { asserted: true, scopeAllowlist: ["fixture://other"] } }, "scope_denied");
});
suite.check("GID-029", () => {
  rejectsConfig({ authorization: { asserted: true, scopeAllowlist: [FIXTURE_TARGET, "*"] } }, "scope_denied");
});
suite.check("GID-030", () => {
  rejectsConfig(
    { authorization: { asserted: true, scopeAllowlist: [FIXTURE_TARGET], trusted: true } },
    "invalid_config",
  );
});
suite.check("GID-031", () => {
  assert.equal(ContractContextSchema.safeParse({ contractVersion: CONTRACT_VERSION, trusted: true }).success, false);
});
suite.check("GID-032", () => {
  assert.deepEqual(AgentControlSchema.parse({ contractVersion: CONTRACT_VERSION, type: "stop" }), {
    contractVersion: CONTRACT_VERSION,
    type: "stop",
  });
});
suite.check("GID-033", () => {
  assert.equal(AgentControlSchema.safeParse({ contractVersion: CONTRACT_VERSION, type: "attach" }).success, false);
});
suite.check("GID-034", () => {
  assert.equal(
    AgentControlSchema.safeParse({
      contractVersion: CONTRACT_VERSION,
      type: "approve",
      approvalId: "approval",
      decision: "auto",
    }).success,
    false,
  );
});
suite.check("GID-035", () => {
  assert.equal(
    AgentControlSchema.safeParse({
      contractVersion: CONTRACT_VERSION,
      type: "review",
      reviewRequestId: "review",
      findingId: "finding",
      decision: "confirm",
      reason: "checked",
    }).success,
    false,
  );
});
suite.check("GID-036", () => {
  assert.throws(() => applyEvent(applyEvent(undefined, start), { ...snapshot, contractVersion: "2.0.0" }));
});
suite.check("GID-037", () => {
  assert.equal(FixtureEventSchema.safeParse({ ...budget, runId: "not-a-uuid" }).success, false);
});
suite.check("GID-038", () => {
  assert.equal(FixtureEventSchema.safeParse({ ...budget, seq: -1 }).success, false);
});
suite.check("GID-039", () => {
  assert.equal(FixtureEventSchema.safeParse({ ...budget, seq: 1.5 }).success, false);
});
suite.check("GID-040", () => {
  assert.equal(FixtureEventSchema.safeParse({ ...budget, authority: "model" }).success, false);
});
suite.check("GID-041", () => {
  assert.equal(
    FixtureEventSchema.safeParse({ ...envelope, seq: 2, type: "finding.candidate", finding: {} }).success,
    false,
  );
});
suite.check("GID-042", () => {
  assert.equal(FixtureEventSchema.safeParse({ ...snapshot, findings: [{ status: "confirmed" }] }).success, false);
});
suite.check("GID-043", () => {
  assert.equal(FixtureEventSchema.safeParse({ ...finished, confirmed: 1 }).success, false);
});
suite.check("GID-044", () => {
  assert.deepEqual(applyEvent(undefined, start).spent, { tokens: 0, steps: 0, wallSec: 0 });
});
suite.check("GID-045", () => {
  assert.throws(() => applyEvent(undefined, budget), { code: "missing_snapshot" });
});
suite.check("GID-046", () => {
  const state = applyEvent(applyEvent(undefined, start), budget);
  assert.equal(applyEvent(state, budget), state);
});
suite.check("GID-047", () => {
  const state = applyEvent(undefined, snapshot);
  assert.equal(applyEvent(state, budget), state);
});
suite.check("GID-048", () => {
  assert.throws(() => applyEvent(applyEvent(undefined, start), { ...budget, seq: 3 }), { code: "event_gap" });
});
suite.check("GID-049", () => {
  assert.throws(() => applyEvent(applyEvent(undefined, start), { ...budget, runId: randomUUID() }), {
    code: "run_mismatch",
  });
});
suite.check("GID-050", () => {
  assert.throws(() => applyEvent(applyEvent(undefined, start), { ...start, seq: 2 }), { code: "duplicate_start" });
});
suite.check("GID-051", () => {
  const state = applyEvent(applyEvent(undefined, start), budget);
  assert.deepEqual(state.spent, budget.spent);
  assert.deepEqual(state.caps, caps);
});
suite.check("GID-052", () => {
  assert.deepEqual(applyEvent(applyEvent(undefined, start), finished).terminal, {
    outcome: "completed",
    cleanupOk: true,
    reportPath: "fixture-report",
  });
});
suite.check("GID-053", () => {
  const state = applyEvent(applyEvent(undefined, start), finished);
  assert.throws(() => applyEvent(state, { ...envelope, seq: 3, type: "step", stepId: "late", summary: "late" }), {
    code: "terminal_transition",
  });
});
suite.check("GID-054", () => {
  const state = applyEvent(undefined, { ...snapshot, seq: 9 });
  assert.equal(applyEvent(state, snapshot).seq, 4);
});
suite.check("GID-055", () => {
  assert.deepEqual(applyEvent(undefined, { ...snapshot, terminal: { outcome: "failed", cleanupOk: false } }).terminal, {
    outcome: "failed",
    cleanupOk: false,
  });
});
suite.check("GID-056", () => {
  const original = { second: { last: 2, first: 1 }, first: 0 };
  const reordered = { first: 0, second: { first: 1, last: 2 } };
  assert.equal(canonicalJson(original), canonicalJson(reordered));
  assert.equal(digest(original), digest(reordered));
});
suite.check("GID-057", () => {
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});
suite.check("GID-058", () => {
  const input = { text: 'quote"\n雪' };
  assert.deepEqual(JSON.parse(canonicalJson(input)), input);
});
suite.check("GID-059", () => {
  for (const value of [Infinity, -Infinity, NaN]) assert.throws(() => canonicalJson(value), { code: "invalid_json" });
});
suite.check("GID-060", () => {
  assert.throws(() => canonicalJson({ nested: { missing: undefined } }), { code: "invalid_json" });
});
suite.check("GID-061", () => {
  assert.throws(() => canonicalJson(new Array(2)), { code: "invalid_json" });
});
suite.check("GID-062", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), { code: "invalid_json" });
  const shared = { finite: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"finite":1},{"finite":1}]');
});
suite.check("GID-063", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
suite.check("GID-064", () => {
  assert.throws(() => databaseConfig({ GIDORAH_DATABASE_URL: "postgresql://localhost/gidorah" }), {
    code: "database_config",
  });
});
suite.check("GID-065", () => {
  const local = "postgresql://localhost/gidorah";
  assert.equal(
    databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", GIDORAH_DATABASE_URL: local, DATABASE_URL: remote })
      .connectionString,
    local,
  );
});
suite.check("GID-066", () => {
  assert.throws(
    () => databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", DATABASE_URL: "postgresql://localhost/gidorah" }),
    { code: "database_config" },
  );
});
suite.check("GID-067", () => {
  for (const profile of ["production", "staging", "unknown"]) {
    assert.throws(
      () =>
        databaseConfig({ GIDORAH_DATABASE_PROFILE: profile, GIDORAH_DATABASE_URL: "postgresql://localhost/gidorah" }),
      { code: "database_config" },
    );
  }
});
suite.check("GID-068", () => {
  for (const suffix of ["?host=remote.invalid", "?sslmode=require", "?options=unsafe", "#override"])
    assert.throws(
      () =>
        databaseConfig({
          GIDORAH_DATABASE_PROFILE: "local",
          GIDORAH_DATABASE_URL: `postgresql://localhost/gidorah${suffix}`,
        }),
      { code: "database_config" },
    );
});
suite.check("GID-069", () => {
  for (const endpoint of [
    "postgresql://remote.invalid/database",
    "https://localhost/database",
    "postgresql://localhost/database?host=remote.invalid",
  ]) {
    assert.throws(() => databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", GIDORAH_DATABASE_URL: endpoint }), {
      code: "database_config",
    });
  }
  const connectionString = "postgresql://localhost:55432/gidorah";
  assert.equal(
    databaseConfig({ GIDORAH_DATABASE_PROFILE: "local", GIDORAH_DATABASE_URL: connectionString }).connectionString,
    connectionString,
  );
});
suite.check("GID-070", () => {
  const message = publicError(new Error(remote));
  assert.equal(message, "internal_failure: The operation failed; no further execution is authorized.");
  assert.equal(message.includes("fixture-password"), false);
});

suite.seal();
