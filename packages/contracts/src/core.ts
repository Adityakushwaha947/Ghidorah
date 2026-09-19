import { z } from "zod";
import {
  BudgetSchema,
  CONTRACT_VERSION,
  IdentifierSchema as text,
  InvestigationModeSchema,
  ProductCapabilitySchema,
  TerminalSchema,
  type AgentControl,
  type ContractContext,
  type RunConfig,
} from "./common.js";
import { FindingSchema, InstallDecisionSchema, VerificationSchema, type Finding, type Review } from "./findings.js";

export const PendingApprovalSchema = z.strictObject({
  approvalId: text,
  action: text,
  risk: z.literal("destructive"),
  detail: text,
});
export const PendingReviewSchema = z.strictObject({ reviewRequestId: text, findingId: text, evidenceRev: text });
const envelope = { contractVersion: z.literal(CONTRACT_VERSION), runId: text, seq: z.number().int().nonnegative() };
const target = {
  target: text,
  mode: InvestigationModeSchema,
  capabilities: z.array(ProductCapabilitySchema).min(1),
  caps: BudgetSchema,
};

export const EventSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ ...envelope, type: z.literal("run.started"), ...target }),
    z.strictObject({
      ...envelope,
      type: z.literal("run.snapshot"),
      ...target,
      spent: BudgetSchema,
      findings: z.array(FindingSchema),
      installDecisions: z.array(InstallDecisionSchema),
      pendingApprovals: z.array(PendingApprovalSchema),
      pendingReviews: z.array(PendingReviewSchema),
      terminal: TerminalSchema.optional(),
    }),
    z.strictObject({ ...envelope, type: z.literal("step"), stepId: text, summary: z.string() }),
    z.strictObject({ ...envelope, type: z.literal("tool.call"), callId: text, tool: text, argsSummary: z.string() }),
    z.strictObject({
      ...envelope,
      type: z.literal("tool.result"),
      callId: text,
      ok: z.boolean(),
      summary: z.string(),
      artifactRef: text,
    }),
    z.strictObject({
      ...envelope,
      type: z.literal("coverage"),
      surface: text,
      outcome: z.enum(["checked", "cleared", "ruled_out"]),
    }),
    z.strictObject({ ...envelope, type: z.literal("dependency.decision"), decision: InstallDecisionSchema }),
    z.strictObject({ ...envelope, type: z.literal("finding.candidate"), finding: FindingSchema }),
    z.strictObject({
      ...envelope,
      type: z.literal("finding.update"),
      findingId: text,
      status: z.enum(["candidate", "confirmed", "discarded"]),
      verification: VerificationSchema,
    }),
    z.strictObject({ ...envelope, type: z.literal("budget"), caps: BudgetSchema, spent: BudgetSchema }),
    z.strictObject({ ...envelope, type: z.literal("approval.request"), ...PendingApprovalSchema.shape }),
    z.strictObject({ ...envelope, type: z.literal("review.request"), ...PendingReviewSchema.shape }),
    z.strictObject({
      ...envelope,
      type: z.literal("run.finished"),
      ...TerminalSchema.shape,
      confirmed: z.number().int().nonnegative(),
      needsHuman: z.number().int().nonnegative(),
      discarded: z.number().int().nonnegative(),
    }),
    z.strictObject({ ...envelope, type: z.literal("error"), message: z.string(), fatal: z.boolean() }),
  ])
  .superRefine((event, context) => {
    const reject = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    const unique = (values: string[]): void => {
      if (new Set(values).size !== values.length) reject("Duplicate event identities.");
    };
    if (event.type === "run.started" || event.type === "run.snapshot") unique(event.capabilities);
    if (
      event.type === "finding.candidate" &&
      (event.finding.runId !== event.runId ||
        event.finding.status !== "candidate" ||
        event.finding.verification.result !== "pending")
    )
      reject("A candidate event must introduce a pending candidate in this run.");
    if (event.type === "finding.update") {
      const checked = event.verification;
      const status = checked.result === "pass" ? "confirmed" : checked.result === "fail" ? "discarded" : "candidate";
      if (event.status !== status) reject("Finding update status disagrees with verification.");
      if (status !== "candidate" && (!checked.method || !checked.artifactRef || !checked.receipt))
        reject("Terminal updates require independent proof.");
      if (
        status === "candidate" &&
        (checked.method || checked.receipt || checked.review || (checked.result === "pending" && checked.artifactRef))
      )
        reject("Pending updates cannot claim proof.");
      if (checked.receipt && (checked.receipt.runId !== event.runId || checked.receipt.findingId !== event.findingId))
        reject("Receipt identity differs from the update.");
    }
    if (event.type === "run.snapshot") {
      unique(event.findings.map((finding) => finding.id));
      unique(event.installDecisions.map((decision) => decision.id));
      unique(event.pendingApprovals.map((approval) => approval.approvalId));
      unique(event.pendingReviews.map((review) => review.reviewRequestId));
      unique(event.pendingReviews.map((review) => review.findingId));
      for (const finding of event.findings) {
        if (finding.runId !== event.runId || !event.capabilities.includes(finding.capability))
          reject("Snapshot finding is outside this run.");
      }
      for (const review of event.pendingReviews) {
        const finding = event.findings.find((entry) => entry.id === review.findingId);
        if (
          !finding ||
          finding.verification.result !== "needs_human" ||
          finding.evidence.revision !== review.evidenceRev
        )
          reject("Review does not bind an inconclusive finding and its evidence.");
      }
    }
  });

export type Event = z.infer<typeof EventSchema>;
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;
export type PendingReview = z.infer<typeof PendingReviewSchema>;
export type RunHandle = { runId: string; events: AsyncIterable<Event>; control: (control: AgentControl) => void };
export interface AgentApi {
  run(target: string, config: RunConfig): RunHandle;
  recover(runId: string, context: ContractContext): RunHandle;
  observe(runId: string, context: ContractContext): AsyncIterable<Event>;
  getArtifact(
    runId: string,
    artifactRef: string,
    context: ContractContext,
  ): Promise<{ bytes: string; redacted: boolean }>;
  getPendingReview(
    runId: string,
    findingId: string,
    context: ContractContext,
  ): Promise<{ finding: Finding; reviewRequestId: string; evidenceRev: string } | null>;
  getReview(runId: string, findingId: string, context: ContractContext): Promise<Review | null>;
}
