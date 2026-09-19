import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, FIXTURE_TARGET, fixtureConfig, validateFixtureRun } from "@ghidorah/foundation";
import { sha256 } from "@ghidorah/foundation";
import {
  admitIndependentVerification,
  candidateRevision,
  FindingSchema,
  InstallDecisionSchema,
  subjectDigest,
  type Finding,
  type IndependentVerificationContext,
  type VerificationMethod,
} from "@ghidorah/foundation";

const bytes = "Synthetic evidence for contract tests only; no vulnerability was assessed.";
const artifactRef = `sha256:${sha256(bytes)}`;
const checkedAt = "2026-09-19T00:00:00.000Z";
const subject = { kind: "source", repository: "fixture-repo", revision: "head-1", path: "fixture.ts" };
const dependency = {
  kind: "dependency",
  package: { ecosystem: "npm", name: "synthetic", version: "1.0.0", registry: "fixture" },
  contextRef: "inventory-1",
  advisoryIds: ["fixture-advisory"],
};
const change = { repository: "fixture-repo", baseRevision: "base-1", headRevision: "head-1" };
const variants: { label: string; fields: Record<string, unknown>; method: VerificationMethod }[] = [
  {
    label: "Code vulnerability",
    fields: { capability: "code", surface: "code", claim: "vulnerability", subject },
    method: "witness",
  },
  {
    label: "PR vulnerability",
    fields: { capability: "pull_requests", surface: "code", claim: "vulnerability", subject, change },
    method: "witness",
  },
  {
    label: "Weak cryptography",
    fields: { capability: "code", surface: "code", claim: "weak_cryptography", subject },
    method: "policy_check",
  },
  {
    label: "Configuration violation",
    fields: {
      capability: "code",
      surface: "configuration",
      claim: "configuration_violation",
      subject: { kind: "configuration", revisionRef: "head-1", resourceRef: "fixture", ruleId: "rule-1" },
    },
    method: "policy_check",
  },
  {
    label: "Runtime vulnerability",
    fields: {
      capability: "agentic_pentesting",
      surface: "runtime",
      claim: "vulnerability",
      subject: { kind: "runtime", targetRef: "fixture", buildIdentityRef: "build-1" },
    },
    method: "replay",
  },
  ...(["secret_exposure", "credential_validity"] as const).map((claim) => ({
    label: claim,
    fields: {
      capability: "secrets",
      surface: "code",
      claim,
      subject: { kind: "secret", credentialRef: "opaque-handle", locationRef: "fixture" },
    },
    method: (claim === "secret_exposure" ? "policy_check" : "credential_check") as VerificationMethod,
  })),
  ...(["advisory_match", "dependency_reachability", "dependency_exploitability", "malicious_package"] as const).map(
    (claim, index) => ({
      label: claim,
      fields: { capability: "supply_chain", surface: "dependency", claim, subject: dependency },
      method: ["advisory_match", "reachability", "witness", "package_analysis"][index] as VerificationMethod,
    }),
  ),
  {
    label: "Firewall malware claim",
    fields: {
      capability: "dependency_firewall",
      surface: "install",
      claim: "malicious_package",
      subject: {
        kind: "install",
        requestId: "install-1",
        package: { ...dependency.package, artifactDigest: "artifact-1" },
        contextRef: "inventory-1",
      },
    },
    method: "package_analysis",
  },
];

function candidate(fields: Record<string, unknown> = variants[0]!.fields): Finding {
  return FindingSchema.parse({
    contractVersion: CONTRACT_VERSION,
    id: "candidate-1",
    runId: "run-1",
    title: "Synthetic contract fixture",
    severity: "high",
    target: "fixture",
    location: "fixture",
    poc: "Synthetic replay instructions",
    evidence: {
      revision: "evidence-1",
      toolCalls: [{ callId: "call-1", tool: "fixture-tool", artifactRef }],
      detail: "Synthetic observation",
    },
    status: "candidate",
    verification: { result: "pending" },
    ...fields,
  });
}

function proof(finding: Finding, method: VerificationMethod = "witness") {
  const authority = {
    kind: (["vulnerability", "dependency_exploitability"].includes(finding.claim)
      ? "gyms_oracle"
      : "independent_check") as "gyms_oracle" | "independent_check",
    id: "fixture-independent-authority",
  };
  const policy = { id: "synthetic-policy", revision: "policy-1" };
  const verdict = {
    result: "pass" as const,
    method,
    artifactRef,
    receipt: {
      runId: finding.runId,
      findingId: finding.id,
      candidateRevision: candidateRevision(finding),
      subjectDigest: subjectDigest(finding),
      evidenceRev: finding.evidence.revision,
      claim: finding.claim,
      policy,
      authority,
      checkedAt,
      expiresAt: "2026-09-20T00:00:00.000Z",
    },
  };
  const context: IndependentVerificationContext = {
    runId: finding.runId,
    capabilities: [finding.capability],
    policy: { ...policy, claims: [finding.claim] },
    authority,
    now: new Date("2026-09-19T01:00:00.000Z"),
    getToolCall: async () => finding.evidence.toolCalls[0]!,
    getArtifact: async () => ({ bytes, redacted: true }),
  };
  return { verdict, context };
}

for (const variant of variants) {
  test(`synthetic contract: ${variant.label} retains its exact claim after independent admission`, async () => {
    const finding = candidate(variant.fields);
    const { verdict, context } = proof(finding, variant.method);
    const confirmed = await admitIndependentVerification(finding, verdict, context);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.claim, finding.claim);
    assert.deepEqual(FindingSchema.parse(JSON.parse(JSON.stringify(confirmed))), confirmed);
    const discarded = await admitIndependentVerification(finding, { ...verdict, result: "fail" }, context);
    assert.equal(discarded.status, "discarded");
  });
}

for (const [label, overrides] of [
  ["confirmed with pending proof", { status: "confirmed" }],
  ["candidate with self-authored pass", { verification: { result: "pass" } }],
  ["unknown capability", { capability: "invented" }],
  ["wrong subject for capability", { subject: dependency }],
  ["PR without change", { capability: "pull_requests" }],
  ["source differs from PR head", { capability: "pull_requests", change: { ...change, headRevision: "other" } }],
  ["missing core version", { contractVersion: undefined }],
  ["unknown core version", { contractVersion: "2.0.0" }],
] as const) {
  test(`finding schema rejects ${label}`, () => {
    assert.throws(() => FindingSchema.parse({ ...candidate(), ...overrides }));
  });
}

for (const [label, mutation] of [
  ["authority", { authority: { kind: "gyms_oracle", id: "model-authored" } }],
  ["policy", { policy: { id: "synthetic-policy", revision: "other" } }],
  ["run identity", { runId: "other" }],
  ["candidate revision", { candidateRevision: "other" }],
  ["subject", { subjectDigest: "other" }],
  ["evidence", { evidenceRev: "other" }],
  ["claim", { claim: "malicious_package" }],
  ["expired check", { expiresAt: "2026-09-19T00:30:00.000Z" }],
  ["future check", { checkedAt: "2026-09-19T02:00:00.000Z" }],
] as const) {
  test(`receipt admission rejects forged or stale ${label}`, async () => {
    const finding = candidate();
    const { verdict, context } = proof(finding);
    await assert.rejects(
      admitIndependentVerification(finding, { ...verdict, receipt: { ...verdict.receipt, ...mutation } }, context),
    );
  });
}

test("receipt cannot be reused after candidate content changes", async () => {
  const finding = candidate();
  const { verdict, context } = proof(finding);
  await assert.rejects(admitIndependentVerification({ ...finding, title: "A different claim" }, verdict, context));
  const confirmed = await admitIndependentVerification(finding, verdict, context);
  await assert.rejects(admitIndependentVerification(confirmed, verdict, context));
});

test("advisory facts cannot be admitted as exploit or malware proof", async () => {
  const finding = candidate(variants.find((variant) => variant.label === "advisory_match")!.fields);
  const { verdict, context } = proof(finding, "witness");
  await assert.rejects(admitIndependentVerification(finding, verdict, context));
});

test("claim schema support does not enable any additional execution capability", () => {
  for (const capability of ["code", "pull_requests", "secrets", "supply_chain", "dependency_firewall"] as const) {
    assert.throws(
      () =>
        validateFixtureRun(
          FIXTURE_TARGET,
          fixtureConfig({ capabilities: [capability], ...(capability === "pull_requests" ? { change } : {}) }),
        ),
      { code: "unsupported_profile" },
    );
  }
});

test("verification rejects a valid claim outside the run capability set", async () => {
  const finding = candidate();
  const { verdict, context } = proof(finding);
  await assert.rejects(admitIndependentVerification(finding, verdict, { ...context, capabilities: ["secrets"] }));
});

test("grounding rejects missing, misbound, unredacted and tampered artifacts", async () => {
  const finding = candidate();
  const { verdict, context } = proof(finding);
  for (const getToolCall of [async () => null, async () => ({ ...finding.evidence.toolCalls[0]!, callId: "other" })]) {
    await assert.rejects(admitIndependentVerification(finding, verdict, { ...context, getToolCall }));
  }
  for (const getArtifact of [
    async () => ({ bytes: "tampered", redacted: true }),
    async () => ({ bytes, redacted: false }),
    async () => {
      throw new Error("private storage diagnostics");
    },
  ]) {
    await assert.rejects(admitIndependentVerification(finding, verdict, { ...context, getArtifact }), {
      code: "verification_denied",
    });
  }
});

test("credential validity requires an expiring receipt", async () => {
  const finding = candidate(variants.find((variant) => variant.label === "credential_validity")!.fields);
  const { verdict, context } = proof(finding, "credential_check");
  const { expiresAt: _expiresAt, ...receipt } = verdict.receipt;
  await assert.rejects(admitIndependentVerification(finding, { ...verdict, receipt }, context));
});

test("a human receipt cannot enter through the automatic verification adapter", async () => {
  const finding = candidate();
  const { verdict, context } = proof(finding, "human_review");
  await assert.rejects(
    admitIndependentVerification(
      finding,
      { ...verdict, receipt: { ...verdict.receipt, authority: { kind: "human", id: "reviewer" } } },
      context,
    ),
  );
});

test("human-adjudicated schema records retain explicit authority and matching review", () => {
  const finding = candidate();
  for (const method of ["replay", "human_review"] as const) {
    const { verdict } = proof(finding, method);
    const checked = {
      ...verdict,
      receipt: { ...verdict.receipt, authority: { kind: "human", id: "reviewer-1" } },
      review: {
        reviewer: "reviewer-1",
        reason: "Synthetic schema example, not a real adjudication",
        at: checkedAt,
        evidenceRev: finding.evidence.revision,
        decision: "confirm",
      },
    };
    const confirmed = FindingSchema.parse({ ...finding, status: "confirmed", verification: checked });
    assert.equal(confirmed.verification.receipt?.authority.kind, "human");
    assert.throws(() =>
      FindingSchema.parse({
        ...confirmed,
        verification: { ...checked, review: { ...checked.review, evidenceRev: "stale" } },
      }),
    );
  }
});

test("policy-only install blocks remain operational decisions, not confirmed findings", () => {
  const decision = {
    contractVersion: CONTRACT_VERSION,
    id: "decision-1",
    subject: variants.at(-1)!.fields.subject,
    policy: { id: "fixture", revision: "1" },
    decision: "block",
    basis: "policy",
    effect: "blocked",
    artifactRef,
    at: checkedAt,
  };
  assert.equal(InstallDecisionSchema.parse(decision).basis, "policy");
  assert.throws(() => FindingSchema.parse(decision));
  assert.throws(() => InstallDecisionSchema.parse({ ...decision, effect: "released" }));
});
