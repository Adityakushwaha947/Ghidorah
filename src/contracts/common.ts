import { z } from "zod";

export const CONTRACT_VERSION = "1.0.0" as const;
export const SEAM_VERSION = { oracle: "3.0.0", ranges: "2.0.0", model: "1.0.0" } as const;
export const IdentifierSchema = z.string().min(1);
export const PositiveIntegerSchema = z.number().int().positive().max(2_147_483_647);
export const InvestigationModeSchema = z.enum(["pentest", "codereview"]);
export const ProductCapabilitySchema = z.enum([
  "code",
  "pull_requests",
  "agentic_pentesting",
  "secrets",
  "supply_chain",
  "dependency_firewall",
]);
export const ChangeContextSchema = z.strictObject({
  repository: IdentifierSchema,
  baseRevision: IdentifierSchema,
  headRevision: IdentifierSchema,
  pullRequestId: IdentifierSchema.optional(),
});
export const ContractContextSchema = z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION) });
export const ContractVersionErrorSchema = z.strictObject({
  code: z.literal("contract_version_mismatch"),
  expected: z.literal(CONTRACT_VERSION),
  received: z.string().nullable(),
  message: z.string(),
});
export const RunConfigSchema = z
  .strictObject({
    contractVersion: z.literal(CONTRACT_VERSION),
    model: IdentifierSchema.optional(),
    capabilities: z.array(ProductCapabilitySchema).min(1).optional(),
    change: ChangeContextSchema.optional(),
    capTokens: PositiveIntegerSchema,
    capSteps: PositiveIntegerSchema,
    capWallSec: PositiveIntegerSchema,
    capUsd: z.number().finite().nonnegative().optional(),
    approvalProfile: z.enum(["live-target", "closed-world"]),
    targetKind: z.enum(["repo", "web"]).optional(),
    authorization: z.strictObject({ asserted: z.boolean(), scopeAllowlist: z.array(IdentifierSchema).min(1) }),
  })
  .superRefine((config, context) => {
    if (config.capabilities && new Set(config.capabilities).size !== config.capabilities.length)
      context.addIssue({ code: "custom", message: "Capabilities must be unique." });
    if (config.capabilities?.includes("pull_requests") && !config.change)
      context.addIssue({ code: "custom", message: "PR capability requires pinned change context." });
  });
export const BudgetSchema = z.strictObject({
  tokens: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  wallSec: z.number().finite().nonnegative(),
  usd: z.number().finite().nonnegative().optional(),
});
export const TerminalSchema = z.strictObject({
  outcome: z.enum(["completed", "stopped", "failed", "incomplete"]),
  cleanupOk: z.boolean(),
  reportPath: z.string().optional(),
});
export const AgentControlSchema = z.discriminatedUnion("type", [
  z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("stop") }),
  z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("pause") }),
  z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("resume") }),
  z.strictObject({
    contractVersion: z.literal(CONTRACT_VERSION),
    type: z.literal("approve"),
    approvalId: IdentifierSchema,
    decision: z.enum(["allow", "deny"]),
  }),
  z.strictObject({
    contractVersion: z.literal(CONTRACT_VERSION),
    type: z.literal("review"),
    reviewRequestId: IdentifierSchema,
    findingId: IdentifierSchema,
    decision: z.enum(["confirm", "reject"]),
    reason: IdentifierSchema,
    evidenceRev: IdentifierSchema,
  }),
]);
export type ContractContext = z.infer<typeof ContractContextSchema>;
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type Terminal = z.infer<typeof TerminalSchema>;
export type AgentControl = z.infer<typeof AgentControlSchema>;
export type ProductCapability = z.infer<typeof ProductCapabilitySchema>;
export type InvestigationMode = z.infer<typeof InvestigationModeSchema>;
