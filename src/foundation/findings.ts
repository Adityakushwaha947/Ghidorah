import { z } from "zod";
import { CONTRACT_VERSION, validateVersion } from "./contracts.js";
import { digest, sha256 } from "./digest.js";
import { GidorahError } from "./errors.js";

const text = z.string().min(1);
const timestamp = z.iso.datetime();
const change = z.strictObject({ repository: text, baseRevision: text, headRevision: text, pullRequestId: text.optional() });
const policy = z.strictObject({ id: text, revision: text });
const packageIdentity = z.strictObject({ ecosystem: text, name: text, version: text, registry: text, artifactDigest: text.optional() });
const toolCall = z.strictObject({ callId: text, tool: text, artifactRef: text });
const claims = z.enum(["vulnerability", "weak_cryptography", "configuration_violation", "secret_exposure", "credential_validity", "advisory_match", "dependency_reachability", "dependency_exploitability", "malicious_package"]);
const methods = z.enum(["flag", "witness", "replay", "credential_check", "advisory_match", "reachability", "package_analysis", "policy_check", "human_review"]);

export const VerificationReceiptSchema = z.strictObject({
  runId: text, findingId: text, candidateRevision: text, subjectDigest: text, evidenceRev: text, claim: claims,
  policy, authority: z.strictObject({ kind: z.enum(["gyms_oracle", "independent_check", "human"]), id: text }),
  checkedAt: timestamp, expiresAt: timestamp.optional(),
});

const review = z.strictObject({ reviewer: text, reason: text, at: timestamp, evidenceRev: text, decision: z.enum(["confirm", "reject"]) });
const verification = z.strictObject({
  result: z.enum(["pending", "pass", "fail", "needs_human"]), method: methods.optional(),
  artifactRef: text.optional(), receipt: VerificationReceiptSchema.optional(), review: review.optional(),
});
const common = {
  contractVersion: z.literal(CONTRACT_VERSION), id: text, runId: text, title: text,
  severity: z.enum(["critical", "high", "medium", "low"]), cwe: text.optional(), target: text, location: text,
  change: change.optional(), evidence: z.strictObject({ revision: text, toolCalls: z.array(toolCall), detail: text }),
  poc: text.optional(), chain: z.array(z.strictObject({ findingId: text.optional(), summary: text, capabilityGained: text.optional() })).optional(),
  status: z.enum(["candidate", "confirmed", "discarded"]), verification,
};
const installSubject = z.strictObject({
  kind: z.literal("install"), requestId: text, package: packageIdentity.extend({ artifactDigest: text }), contextRef: text,
});

const findingVariants = z.union([
  z.strictObject({ ...common, capability: z.enum(["code", "pull_requests"]), surface: z.literal("code"), claim: z.enum(["vulnerability", "weak_cryptography"]), subject: z.strictObject({ kind: z.literal("source"), repository: text, revision: text, path: text }) }),
  z.strictObject({ ...common, capability: z.enum(["code", "pull_requests"]), surface: z.literal("configuration"), claim: z.literal("configuration_violation"), subject: z.strictObject({ kind: z.literal("configuration"), revisionRef: text, resourceRef: text, ruleId: text }) }),
  z.strictObject({ ...common, capability: z.literal("agentic_pentesting"), surface: z.enum(["web", "runtime"]), claim: z.literal("vulnerability"), subject: z.strictObject({ kind: z.literal("runtime"), targetRef: text, buildIdentityRef: text }) }),
  z.strictObject({ ...common, capability: z.literal("secrets"), surface: z.enum(["code", "ci", "web", "runtime"]), claim: z.enum(["secret_exposure", "credential_validity"]), subject: z.strictObject({ kind: z.literal("secret"), credentialRef: text, locationRef: text, provider: text.optional() }) }),
  z.strictObject({ ...common, capability: z.literal("supply_chain"), surface: z.literal("dependency"), claim: z.enum(["advisory_match", "dependency_reachability", "dependency_exploitability", "malicious_package"]), subject: z.strictObject({ kind: z.literal("dependency"), package: packageIdentity, contextRef: text, advisoryIds: z.array(text) }) }),
  z.strictObject({ ...common, capability: z.literal("dependency_firewall"), surface: z.literal("install"), claim: z.literal("malicious_package"), subject: installSubject }),
]);

export type Finding = z.infer<typeof findingVariants>;
export type FindingClaim = Finding["claim"];
export type VerificationMethod = z.infer<typeof methods>;
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;

const automaticMethods: Record<FindingClaim, readonly VerificationMethod[]> = {
  vulnerability: ["flag", "witness", "replay"], weak_cryptography: ["policy_check"],
  configuration_violation: ["policy_check"], secret_exposure: ["policy_check"], credential_validity: ["credential_check"],
  advisory_match: ["advisory_match"], dependency_reachability: ["reachability"],
  dependency_exploitability: ["witness", "replay"], malicious_package: ["package_analysis"],
};

export function candidateRevision(finding: Finding): string {
  return digest({ ...finding, status: "candidate", verification: { result: "pending" } });
}

export function subjectDigest(finding: Finding): string {
  return digest({ subject: finding.subject, ...(finding.change ? { change: finding.change } : {}) });
}

export const FindingSchema = findingVariants.superRefine((finding, context) => {
  const reject = (message: string): void => { context.addIssue({ code: "custom", message }); };
  const checked = finding.verification;
  if (finding.capability === "pull_requests" && !finding.change) reject("PR findings require pinned change context.");
  if (finding.subject.kind === "source" && finding.change
      && (finding.subject.revision !== finding.change.headRevision || finding.subject.repository !== finding.change.repository)) reject("Source identity must match the pinned head.");
  if (new Set(finding.evidence.toolCalls.map((call) => call.callId)).size !== finding.evidence.toolCalls.length) reject("Evidence tool-call identities must be unique.");
  if (checked.result === "pending" || checked.result === "needs_human") {
    if (finding.status !== "candidate") reject("An unverified finding cannot be terminal.");
    if (checked.method || checked.receipt || checked.review || (checked.result === "pending" && checked.artifactRef)) reject("An unverified candidate cannot supply a verification receipt.");
    return;
  }
  if (finding.status !== (checked.result === "pass" ? "confirmed" : "discarded")) reject("Finding status and verification result disagree.");
  if (!checked.method || !checked.artifactRef || !checked.receipt || !finding.evidence.toolCalls.length) {
    reject("Terminal findings require independent proof and grounded observations.");
    return;
  }
  const receipt = checked.receipt;
  if (finding.claim === "credential_validity" && !receipt.expiresAt) reject("Credential checks require an expiry.");
  if (receipt.runId !== finding.runId || receipt.findingId !== finding.id || receipt.claim !== finding.claim
      || receipt.evidenceRev !== finding.evidence.revision || receipt.candidateRevision !== candidateRevision(finding)
      || receipt.subjectDigest !== subjectDigest(finding)) reject("Receipt does not bind the original candidate and evidence.");
  if (receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.parse(receipt.checkedAt)) reject("Receipt expiry must follow the check.");
  if (receipt.authority.kind === "human") {
    if (!checked.review || !["replay", "human_review"].includes(checked.method)) reject("Human adjudication requires an explicit review and method.");
    if (checked.review && (checked.review.reviewer !== receipt.authority.id || checked.review.evidenceRev !== finding.evidence.revision
        || checked.review.at !== receipt.checkedAt || checked.review.decision !== (checked.result === "pass" ? "confirm" : "reject"))) reject("Human review and receipt disagree.");
    if (checked.method === "replay" && !["vulnerability", "dependency_exploitability"].includes(finding.claim)) reject("Runtime replay cannot prove a different kind of claim.");
  } else {
    if (checked.review || !automaticMethods[finding.claim].includes(checked.method)) reject("This automatic method cannot establish the named claim.");
    const expectedAuthority = ["vulnerability", "dependency_exploitability"].includes(finding.claim) ? "gyms_oracle" : "independent_check";
    if (receipt.authority.kind !== expectedAuthority) reject("Claim requires its accepted independent authority.");
  }
  if (["flag", "witness", "replay"].includes(checked.method) && !finding.poc) reject("Runtime proof requires redacted replay instructions.");
});

export const InstallDecisionSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION), id: text, subject: installSubject, policy,
  decision: z.enum(["allow", "block", "error"]), basis: z.enum(["known_malware", "policy", "heuristic", "unavailable"]),
  effect: z.enum(["released", "blocked", "unknown"]), artifactRef: text, at: timestamp,
}).superRefine((decision, context) => {
  if (decision.effect === "released" && decision.decision !== "allow") context.addIssue({ code: "custom", message: "A release requires an allow decision." });
});

export type IndependentVerificationContext = {
  runId: string;
  capabilities: readonly Finding["capability"][];
  policy: { id: string; revision: string; claims: readonly FindingClaim[]; requiresExpiry?: boolean };
  authority: { kind: "gyms_oracle" | "independent_check"; id: string };
  now: Date;
  getToolCall: (runId: string, callId: string) => Promise<z.infer<typeof toolCall> | null>;
  getArtifact: (runId: string, artifactRef: string) => Promise<{ bytes: string; redacted: boolean }>;
};

const independentVerdict = verification.extend({ result: z.enum(["pass", "fail"]), method: methods, artifactRef: text, receipt: VerificationReceiptSchema, review: z.never().optional() });

export async function admitIndependentVerification(candidate: unknown, verdict: unknown, context: IndependentVerificationContext): Promise<Finding> {
  validateVersion(candidate);
  const finding = FindingSchema.parse(candidate);
  const checked = independentVerdict.parse(verdict);
  const deny = (): never => { throw new GidorahError("verification_denied", "Verification identity, policy, authority, freshness or evidence was not accepted."); };
  if (finding.status !== "candidate" || finding.verification.result !== "pending" || finding.runId !== context.runId
      || !context.capabilities.includes(finding.capability) || !context.policy.claims.includes(finding.claim)) deny();
  const receipt = checked.receipt;
  if (receipt.authority.kind !== context.authority.kind || receipt.authority.id !== context.authority.id
      || receipt.policy.id !== context.policy.id || receipt.policy.revision !== context.policy.revision) deny();
  const now = context.now.getTime();
  if (!Number.isFinite(now) || Date.parse(receipt.checkedAt) > now || (receipt.expiresAt && Date.parse(receipt.expiresAt) <= now)
      || ((context.policy.requiresExpiry || finding.claim === "credential_validity") && !receipt.expiresAt)) deny();
  const terminal = FindingSchema.parse({ ...finding, status: checked.result === "pass" ? "confirmed" : "discarded", verification: checked });
  try {
    for (const reference of finding.evidence.toolCalls) {
      const recorded = await context.getToolCall(context.runId, reference.callId);
      if (!recorded || recorded.callId !== reference.callId || recorded.tool !== reference.tool || recorded.artifactRef !== reference.artifactRef) deny();
    }
    for (const reference of new Set([...finding.evidence.toolCalls.map((call) => call.artifactRef), checked.artifactRef])) {
      const artifact = await context.getArtifact(context.runId, reference);
      if (!artifact.redacted || reference !== `sha256:${sha256(artifact.bytes)}`) deny();
    }
  } catch { deny(); }
  return terminal;
}
