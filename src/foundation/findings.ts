import { z } from "zod";
import {
  FindingSchema as WireFindingSchema,
  VerificationSchema,
  VerificationReceiptSchema,
  type Finding,
  type FindingClaim,
} from "../contracts/findings.js";
import { validateVersion } from "./fixture-contract.js";
import { digest, sha256 } from "./digest.js";
import { GidorahError } from "./errors.js";

export { InstallDecisionSchema, VerificationReceiptSchema } from "../contracts/findings.js";
export type { Finding, FindingClaim, VerificationMethod, VerificationReceipt } from "../contracts/findings.js";

export function candidateRevision(finding: Finding): string {
  return digest({ ...finding, status: "candidate", verification: { result: "pending" } });
}

export function subjectDigest(finding: Finding): string {
  return digest({ subject: finding.subject, ...(finding.change ? { change: finding.change } : {}) });
}

export const FindingSchema = WireFindingSchema.superRefine((finding, context) => {
  const receipt = finding.verification.receipt;
  if (
    receipt &&
    (receipt.candidateRevision !== candidateRevision(finding) || receipt.subjectDigest !== subjectDigest(finding))
  ) {
    context.addIssue({ code: "custom", message: "Receipt does not bind the original candidate and subject." });
  }
});

export type IndependentVerificationContext = {
  runId: string;
  capabilities: readonly Finding["capability"][];
  policy: { id: string; revision: string; claims: readonly FindingClaim[]; requiresExpiry?: boolean };
  authority: { kind: "gyms_oracle" | "independent_check"; id: string };
  now: Date;
  getToolCall: (runId: string, callId: string) => Promise<Finding["evidence"]["toolCalls"][number] | null>;
  getArtifact: (runId: string, artifactRef: string) => Promise<{ bytes: string; redacted: boolean }>;
};

const independentVerdict = VerificationSchema.extend({
  result: z.enum(["pass", "fail"]),
  method: VerificationSchema.shape.method.unwrap(),
  artifactRef: z.string().min(1),
  receipt: VerificationReceiptSchema,
  review: z.never().optional(),
});

export async function admitIndependentVerification(
  candidate: unknown,
  verdict: unknown,
  context: IndependentVerificationContext,
): Promise<Finding> {
  validateVersion(candidate);
  const finding = FindingSchema.parse(candidate);
  const checked = independentVerdict.parse(verdict);
  const deny = (): never => {
    throw new GidorahError(
      "verification_denied",
      "Verification identity, policy, authority, freshness or evidence was not accepted.",
    );
  };
  if (
    finding.status !== "candidate" ||
    finding.verification.result !== "pending" ||
    finding.runId !== context.runId ||
    !context.capabilities.includes(finding.capability) ||
    !context.policy.claims.includes(finding.claim)
  )
    deny();
  const receipt = checked.receipt;
  if (
    receipt.authority.kind !== context.authority.kind ||
    receipt.authority.id !== context.authority.id ||
    receipt.policy.id !== context.policy.id ||
    receipt.policy.revision !== context.policy.revision
  )
    deny();
  const now = context.now.getTime();
  if (
    !Number.isFinite(now) ||
    Date.parse(receipt.checkedAt) > now ||
    (receipt.expiresAt && Date.parse(receipt.expiresAt) <= now) ||
    ((context.policy.requiresExpiry || finding.claim === "credential_validity") && !receipt.expiresAt)
  )
    deny();
  const terminal = FindingSchema.parse({
    ...finding,
    status: checked.result === "pass" ? "confirmed" : "discarded",
    verification: checked,
  });
  try {
    for (const reference of finding.evidence.toolCalls) {
      const recorded = await context.getToolCall(context.runId, reference.callId);
      if (
        !recorded ||
        recorded.callId !== reference.callId ||
        recorded.tool !== reference.tool ||
        recorded.artifactRef !== reference.artifactRef
      )
        deny();
    }
    for (const reference of new Set([
      ...finding.evidence.toolCalls.map((call) => call.artifactRef),
      checked.artifactRef,
    ])) {
      const artifact = await context.getArtifact(context.runId, reference);
      if (!artifact.redacted || reference !== `sha256:${sha256(artifact.bytes)}`) deny();
    }
  } catch {
    deny();
  }
  return terminal;
}
