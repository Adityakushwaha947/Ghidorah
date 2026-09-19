import { SEAM_VERSION } from "../contracts/common.js";
import { VerifyRequestSchema, VerifyVerdictSchema, type VerifyRequest, type VerifyVerdict } from "../contracts/gyms.js";
import { canonicalJson, digest, sha256 } from "./digest.js";
import { GidorahError } from "./errors.js";
import { candidateRevision, FindingSchema } from "./findings.js";

export function validateVerificationRequest(input: unknown, executionPathBytes: string): VerifyRequest {
  if (!input || typeof input !== "object" || !("seamVersion" in input) || input.seamVersion !== SEAM_VERSION.oracle) {
    throw new GidorahError("version_mismatch", "Expected the supported Oracle seam version.");
  }
  const request = VerifyRequestSchema.parse(input);
  FindingSchema.parse(request.candidate);
  if (request.identity.candidateRevision !== candidateRevision(request.candidate)
      || request.identity.pocInputsDigest !== digest(request.pocInputs)
      || request.identity.executionPathDigest !== sha256(executionPathBytes)) {
    throw new GidorahError("identity_mismatch", "Verification input differs from its captured identity.");
  }
  return request;
}

export function validateOracleVerdict(request: VerifyRequest, input: unknown): VerifyVerdict {
  VerifyRequestSchema.parse(request);
  const verdict = VerifyVerdictSchema.parse(input);
  if (canonicalJson(verdict.identity) !== canonicalJson(request.identity)) throw new GidorahError("identity_mismatch", "Oracle returned a different verification identity.");
  if (verdict.result !== "needs_human") {
    FindingSchema.parse({ ...request.candidate, status: verdict.result === "pass" ? "confirmed" : "discarded",
      verification: { result: verdict.result, method: verdict.method, artifactRef: verdict.artifactRef, receipt: verdict.receipt } });
  }
  return verdict;
}
