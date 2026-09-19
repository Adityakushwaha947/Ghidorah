import { z } from "zod";
import { IdentifierSchema as text, InvestigationModeSchema, SEAM_VERSION } from "./common.js";
import { FindingSchema, VerificationReceiptSchema } from "./findings.js";

export const TargetIdentitySchema = z.strictObject({ rangeId: text, instanceId: text, resetGeneration: text, taskRevision: text, targetRevision: text });
export const VerificationIdentitySchema = TargetIdentitySchema.extend({
  runId: text, attemptId: text, candidateId: text, candidateRevision: text, pocInputsDigest: text, predicateRevision: text, executionPathDigest: text,
});
export const VerifyRequestSchema = z.strictObject({
  seamVersion: z.literal(SEAM_VERSION.oracle), identity: VerificationIdentitySchema, mode: InvestigationModeSchema,
  candidate: FindingSchema, pocInputs: z.array(z.string()), executionPathRef: text,
}).superRefine((request, context) => {
  if (request.candidate.id !== request.identity.candidateId || request.candidate.runId !== request.identity.runId
      || request.candidate.status !== "candidate" || request.candidate.verification.result !== "pending") {
    context.addIssue({ code: "custom", message: "Verification requires a pending candidate with matching run and candidate identity." });
  }
});
const verdictEnvelope = { seamVersion: z.literal(SEAM_VERSION.oracle), identity: VerificationIdentitySchema };
export const VerifyVerdictSchema = z.union([
  z.strictObject({ ...verdictEnvelope, result: z.enum(["pass", "fail"]), method: z.enum(["flag", "witness", "replay"]), artifactRef: text, receipt: VerificationReceiptSchema, detail: z.string().optional() }),
  z.strictObject({ ...verdictEnvelope, result: z.literal("needs_human"), reason: z.enum(["unsupported", "insufficient_evidence", "human_replay"]), artifactRef: text.optional(), detail: z.string() }),
]).superRefine((verdict, context) => {
  if (verdict.result === "needs_human") return;
  const receipt = verdict.receipt;
  if (receipt.authority.kind !== "gyms_oracle" || !["vulnerability", "dependency_exploitability"].includes(receipt.claim)
      || (receipt.claim === "dependency_exploitability" && verdict.method === "flag")
      || receipt.runId !== verdict.identity.runId || receipt.findingId !== verdict.identity.candidateId
      || receipt.candidateRevision !== verdict.identity.candidateRevision || receipt.policy.revision !== verdict.identity.predicateRevision) {
    context.addIssue({ code: "custom", message: "Oracle receipt does not bind a supported runtime claim and predicate." });
  }
});
export const OracleErrorSchema = z.strictObject({
  code: z.enum(["engine_failure", "timeout", "version_mismatch", "unavailable", "invalid_request", "identity_mismatch", "attempt_conflict", "in_progress", "uncertain_execution"]), message: z.string(),
});
export const RangeEligibilitySchema = z.discriminatedUnion("eligible", [
  z.strictObject({ eligible: z.literal(true), identity: TargetIdentitySchema, endpoint: text, expiresAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ eligible: z.literal(false), reason: text }),
]);
export type TargetIdentity = z.infer<typeof TargetIdentitySchema>;
export type VerificationIdentity = z.infer<typeof VerificationIdentitySchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type VerifyVerdict = z.infer<typeof VerifyVerdictSchema>;
export type OracleError = z.infer<typeof OracleErrorSchema>;
export type RangeEligibility = z.infer<typeof RangeEligibilitySchema>;
export interface Oracle {
  readonly seamVersion: typeof SEAM_VERSION.oracle;
  verify(request: VerifyRequest, options: { timeoutMs: number }): Promise<VerifyVerdict>;
}
export interface RangesRegistry {
  readonly seamVersion: typeof SEAM_VERSION.ranges;
  resolve(target: string): Promise<RangeEligibility>;
}
