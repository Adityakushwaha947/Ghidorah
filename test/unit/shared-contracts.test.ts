import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import * as contracts from "../../src/contracts/index.js";
import { fixtureConfig, validateFixtureRun, FIXTURE_TARGET } from "../../src/foundation/contracts.js";
import { validateOracleVerdict, validateVerificationRequest } from "../../src/foundation/verification.js";
import { candidate, modelRequest, modelResponse, verificationRequest, verdict } from "../helpers/contract-fixtures.js";

test("shared wire definitions do not import the backend, Node, PostgreSQL or Mastra", async () => {
  const root = resolve("src/contracts");
  for (const file of await readdir(root)) {
    const source = await readFile(resolve(root, file), "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
      assert.ok(match[2] === "zod" || match[2]?.startsWith("./"), `${file} imports ${match[2]}`);
    }
    assert.doesNotMatch(source, /\b(?:Buffer|process)\s*[.\[]|\brequire\s*\(/);
  }
});

test("every exported wire schema can generate portable JSON Schema", () => {
  const entries = Object.entries(contracts).filter(([name]) => name.endsWith("Schema"));
  assert.ok(entries.length >= 25);
  for (const [name, schema] of entries) {
    assert.ok(schema instanceof z.ZodType, name);
    assert.equal(z.toJSONSchema(schema as z.ZodType).$schema, "https://json-schema.org/draft/2020-12/schema");
  }
});

test("shared RunConfig rejects duplicate capabilities and PRs without pinned change context", () => {
  assert.throws(() => contracts.RunConfigSchema.parse(fixtureConfig({ capabilities: ["code", "code"] })));
  assert.throws(() => contracts.RunConfigSchema.parse(fixtureConfig({ capabilities: ["pull_requests"] })));
  assert.equal(contracts.RunConfigSchema.parse(fixtureConfig({ capabilities: ["pull_requests"], change: { repository: "fixture", baseRevision: "base", headRevision: "head" } })).capabilities?.[0], "pull_requests");
  assert.throws(() => validateFixtureRun(FIXTURE_TARGET, fixtureConfig({ capabilities: ["code"] })));
});

test("candidate and snapshot contracts preserve claim, evidence and independent receipts", () => {
  const finding = candidate();
  const envelope = { contractVersion: "1.0.0", runId: finding.runId, seq: 5 };
  const event = { ...envelope, type: "finding.candidate", finding };
  assert.deepEqual(contracts.EventSchema.parse(JSON.parse(JSON.stringify(event))), event);
  const proof = verdict();
  const confirmed = { ...finding, status: "confirmed", verification: { result: proof.result, method: proof.method, artifactRef: proof.artifactRef, receipt: proof.receipt } };
  const snapshot = { ...envelope, type: "run.snapshot", target: finding.target, mode: "pentest", capabilities: [finding.capability], caps: { tokens: 100, steps: 10, wallSec: 60 }, spent: { tokens: 10, steps: 1, wallSec: 1 }, findings: [confirmed], installDecisions: [], pendingApprovals: [], pendingReviews: [], terminal: { outcome: "completed", cleanupOk: true } };
  assert.deepEqual(contracts.EventSchema.parse(JSON.parse(JSON.stringify(snapshot))), snapshot);
  assert.throws(() => contracts.EventSchema.parse({ ...event, finding: confirmed }));
  assert.throws(() => contracts.EventSchema.parse({ ...snapshot, contractVersion: "legacy" }));
  assert.throws(() => contracts.EventSchema.parse({ ...snapshot, capabilities: ["code"] }));
  assert.throws(() => contracts.EventSchema.parse({ ...snapshot, runId: "other" }));
  assert.throws(() => contracts.EventSchema.parse({ ...snapshot, findings: [confirmed, confirmed] }));
});

test("review snapshots bind the same inconclusive finding and evidence revision", () => {
  const finding = { ...candidate(), verification: { result: "needs_human" } };
  const review = { reviewRequestId: "review-1", findingId: finding.id, evidenceRev: finding.evidence.revision };
  const snapshot = { contractVersion: "1.0.0", runId: finding.runId, seq: 1, type: "run.snapshot", target: finding.target, mode: "pentest", capabilities: [finding.capability], caps: { tokens: 100, steps: 10, wallSec: 60 }, spent: { tokens: 1, steps: 1, wallSec: 1 }, findings: [finding], installDecisions: [], pendingApprovals: [], pendingReviews: [review] };
  assert.ok(contracts.EventSchema.safeParse(snapshot).success);
  for (const pendingReviews of [[{ ...review, findingId: "other" }], [{ ...review, evidenceRev: "old" }], [review, { ...review, reviewRequestId: "another" }]]) {
    assert.throws(() => contracts.EventSchema.parse({ ...snapshot, pendingReviews }));
  }
});

test("finding updates cannot assert confirmation without proof or use another run's receipt", () => {
  const proof = verdict();
  const event = { contractVersion: "1.0.0", runId: proof.identity.runId, seq: 2, type: "finding.update", findingId: proof.identity.candidateId, status: "confirmed", verification: { result: "pass", method: proof.method, artifactRef: proof.artifactRef, receipt: proof.receipt } };
  assert.ok(contracts.EventSchema.safeParse(event).success);
  assert.throws(() => contracts.EventSchema.parse({ ...event, verification: { result: "pass" } }));
  assert.throws(() => contracts.EventSchema.parse({ ...event, status: "candidate" }));
  assert.throws(() => contracts.EventSchema.parse({ ...event, runId: "other" }));
  assert.throws(() => contracts.EventSchema.parse({ ...event, verification: { result: "pending", receipt: proof.receipt } }));
});

test("Oracle request validation binds captured candidate, PoC inputs and execution bytes", () => {
  const request = verificationRequest();
  assert.deepEqual(validateVerificationRequest(request, "synthetic execution"), request);
  assert.throws(() => validateVerificationRequest(request, "changed execution"));
  assert.throws(() => validateVerificationRequest({ ...request, pocInputs: ["changed"] }, "synthetic execution"));
  assert.throws(() => validateVerificationRequest({ ...request, candidate: { ...request.candidate, title: "changed" } }, "synthetic execution"));
  assert.throws(() => validateVerificationRequest({ ...request, seamVersion: "2.0.0" }, "synthetic execution"), { code: "version_mismatch" });
  assert.throws(() => validateVerificationRequest({ ...request, candidate: { ...request.candidate, runId: "other" } }, "synthetic execution"));
});

for (const key of Object.keys(verificationRequest().identity)) {
  test(`Oracle rejects a verdict with changed ${key}`, () => {
    const response = verdict();
    assert.throws(() => validateOracleVerdict(verificationRequest(), { ...response, identity: { ...response.identity, [key]: "changed" } }));
    assert.throws(() => validateOracleVerdict(verificationRequest(), { seamVersion: "3.0.0", identity: { ...response.identity, [key]: "changed" }, result: "needs_human", reason: "unsupported", detail: "Synthetic inconclusive check" }));
  });
}

test("Oracle receipts cannot substitute another claim, predicate, subject or evidence", () => {
  const response = verdict();
  assert.deepEqual(validateOracleVerdict(verificationRequest(), response), response);
  for (const mutation of [{ claim: "advisory_match" }, { evidenceRev: "other" }, { subjectDigest: "other" }, { policy: { id: "fixture", revision: "other" } }, { authority: { kind: "human", id: "other" } }]) {
    assert.throws(() => validateOracleVerdict(verificationRequest(), { ...response, receipt: { ...response.receipt, ...mutation } }));
  }
});

test("Oracle errors stay errors, distinct from fail and needs_human verdicts", () => {
  for (const code of contracts.OracleErrorSchema.shape.code.options) {
    const error = { code, message: "Synthetic error" };
    assert.deepEqual(contracts.OracleErrorSchema.parse(error), error);
    assert.throws(() => contracts.VerifyVerdictSchema.parse(error));
  }
  const request = verificationRequest();
  const response = { seamVersion: "3.0.0", identity: request.identity, result: "needs_human", reason: "unsupported", detail: "Predicate unavailable for this claim" };
  assert.deepEqual(validateOracleVerdict(request, response), response);
});

test("registry identity and expiry are mandatory; caller allowlists are not eligibility", () => {
  const identity = { rangeId: "fixture", instanceId: "instance", resetGeneration: "1", taskRevision: "1", targetRevision: "1" };
  assert.ok(contracts.RangeEligibilitySchema.safeParse({ eligible: true, identity, endpoint: "fixture://instance", expiresAt: "2026-09-20T00:00:00Z" }).success);
  assert.throws(() => contracts.RangeEligibilitySchema.parse({ eligible: true, identity, endpoint: "fixture://instance" }));
  assert.throws(() => contracts.RangeEligibilitySchema.parse({ eligible: true, scopeAllowlist: ["https://example.invalid"] }));
  assert.deepEqual(contracts.RangeEligibilitySchema.parse({ eligible: false, reason: "not registered" }), { eligible: false, reason: "not registered" });
});

test("model contract validates full tool-result linkage and unique tool/call IDs", () => {
  const tool = { name: "synthetic", description: "fixture", inputSchema: { type: "object" } };
  const call = { callId: "call-1", name: tool.name, arguments: {} };
  const assistant = { role: "assistant" as const, content: "", toolCalls: [call] };
  const result = { role: "tool" as const, callId: call.callId, content: "fixture", isError: false };
  const request = modelRequest({ tools: [tool], messages: [assistant, result] });
  assert.deepEqual(contracts.ModelRequestSchema.parse(request), request);
  for (const messages of [[result], [assistant], [assistant, result, result], [assistant, { ...result, callId: "other" }], [assistant, result, assistant, result], [assistant, { role: "user", content: "skip result" }, result]]) {
    assert.throws(() => contracts.ModelRequestSchema.parse({ ...request, messages }));
  }
  assert.throws(() => contracts.ModelRequestSchema.parse({ ...request, tools: [tool, tool] }));
});

test("model schemas reject unsupported fields, nonfinite settings, missing usage and unsafe completion shapes", () => {
  for (const fields of [{ seamVersion: "2.0.0" }, { maxOutputTokens: 0 }, { maxOutputTokens: 0.5 }, { sampling: { temperature: Infinity } }, { sampling: { seed: 1.5 } }, { helperModel: "hidden" }]) {
    assert.throws(() => contracts.ModelRequestSchema.parse({ ...modelRequest(), ...fields }));
  }
  for (const fields of [{ usage: undefined }, { usage: { inputTokens: -1, outputTokens: 1 } }, { finishReason: "tool_calls" }, { finishReason: "refusal", toolCalls: [{ callId: "call", name: "fixture", arguments: {} }] }]) {
    assert.throws(() => contracts.ModelResponseSchema.parse({ ...modelResponse(), ...fields }));
  }
  assert.throws(() => contracts.ModelStreamEventSchema.parse({ type: "completed", requestId: "different", response: modelResponse() }));
});
