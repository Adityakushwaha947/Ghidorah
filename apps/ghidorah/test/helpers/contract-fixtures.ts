import { SEAM_VERSION } from "@ghidorah/contracts";
import type { ModelRequest, ModelResponse } from "@ghidorah/contracts";
import { FindingSchema, candidateRevision, subjectDigest, type Finding } from "@ghidorah/foundation";
import { digest, sha256 } from "@ghidorah/foundation";
import type { VerifyRequest, VerifyVerdict } from "@ghidorah/contracts";

export function candidate(): Finding {
  return FindingSchema.parse({
    contractVersion: "1.0.0",
    id: "synthetic-candidate",
    runId: "synthetic-run",
    title: "Synthetic contract observation",
    capability: "agentic_pentesting",
    surface: "web",
    claim: "vulnerability",
    severity: "low",
    target: "fixture://contract",
    location: "fixture",
    subject: { kind: "runtime", targetRef: "fixture", buildIdentityRef: "synthetic-build" },
    poc: "Synthetic replay; no target execution.",
    evidence: {
      revision: "evidence-1",
      toolCalls: [{ callId: "call-1", tool: "fixture", artifactRef: `sha256:${sha256("synthetic evidence")}` }],
      detail: "Synthetic evidence only.",
    },
    status: "candidate",
    verification: { result: "pending" },
  });
}

export function verificationRequest(): VerifyRequest {
  const finding = candidate();
  return {
    seamVersion: SEAM_VERSION.oracle,
    identity: {
      rangeId: "fixture-range",
      instanceId: "fixture-instance",
      resetGeneration: "reset-1",
      taskRevision: "task-1",
      targetRevision: "target-1",
      runId: finding.runId,
      attemptId: "attempt-1",
      candidateId: finding.id,
      candidateRevision: candidateRevision(finding),
      pocInputsDigest: digest(["synthetic input"]),
      predicateRevision: "predicate-1",
      executionPathDigest: sha256("synthetic execution"),
    },
    mode: "pentest",
    candidate: finding,
    pocInputs: ["synthetic input"],
    executionPathRef: "synthetic-path",
  };
}

export function verdict(request = verificationRequest()): VerifyVerdict & { result: "pass" } {
  return {
    seamVersion: SEAM_VERSION.oracle,
    identity: { ...request.identity },
    result: "pass",
    method: "witness",
    artifactRef: `sha256:${sha256("synthetic proof")}`,
    receipt: {
      runId: request.identity.runId,
      findingId: request.candidate.id,
      candidateRevision: request.identity.candidateRevision,
      subjectDigest: subjectDigest(request.candidate),
      evidenceRev: request.candidate.evidence.revision,
      claim: request.candidate.claim,
      policy: { id: "synthetic-policy", revision: request.identity.predicateRevision },
      authority: { kind: "gyms_oracle", id: "synthetic-test-authority" },
      checkedAt: "2026-09-19T00:00:00.000Z",
    },
  };
}

export function modelRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    seamVersion: SEAM_VERSION.model,
    requestId: "dispatch-1",
    model: "synthetic-model",
    messages: [{ role: "user", content: "Synthetic fixture only." }],
    tools: [],
    maxOutputTokens: 20,
    ...overrides,
  };
}

export function modelResponse(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    requestId: "dispatch-1",
    model: "synthetic-model-pinned",
    content: "Synthetic result.",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 3 },
    ...overrides,
  };
}
