import { z } from "zod";
import { GidorahError } from "./errors.js";

export const CONTRACT_VERSION = "1.0.0" as const;
export const FIXTURE_TARGET = "fixture://counter" as const;
export const FIXTURE_MODEL = "gidorah-fixture-v1" as const;
export const RUNTIME_VERSION = "gidorah-mastra-fixture/0.1.0" as const;

const positiveInteger = z.number().int().positive().max(2_147_483_647);
const capability = z.enum(["code", "pull_requests", "agentic_pentesting", "secrets", "supply_chain", "dependency_firewall"]);
const change = z.strictObject({
  repository: z.string().min(1), baseRevision: z.string().min(1),
  headRevision: z.string().min(1), pullRequestId: z.string().optional(),
});

export const ContractContextSchema = z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION) });
export type ContractContext = z.infer<typeof ContractContextSchema>;

export const RunConfigSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  model: z.string().min(1).optional(),
  capabilities: z.array(capability).min(1).optional(),
  change: change.optional(),
  capTokens: positiveInteger,
  capSteps: positiveInteger,
  capWallSec: positiveInteger,
  capUsd: z.number().finite().nonnegative().optional(),
  approvalProfile: z.enum(["live-target", "closed-world"]),
  targetKind: z.enum(["repo", "web"]).optional(),
  authorization: z.strictObject({
    asserted: z.boolean(), scopeAllowlist: z.array(z.string().min(1)).min(1),
  }),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

export const BudgetSchema = z.strictObject({
  tokens: z.number().int().nonnegative(), steps: z.number().int().nonnegative(),
  wallSec: z.number().finite().nonnegative(), usd: z.number().finite().nonnegative().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;
export const TerminalSchema = z.strictObject({
  outcome: z.enum(["completed", "stopped", "failed", "incomplete"]),
  cleanupOk: z.boolean(), reportPath: z.string().optional(),
});
export type Terminal = z.infer<typeof TerminalSchema>;

const envelope = {
  contractVersion: z.literal(CONTRACT_VERSION), runId: z.uuid(), seq: z.number().int().nonnegative(),
};
const targetFields = {
  target: z.literal(FIXTURE_TARGET), mode: z.literal("pentest"),
  capabilities: z.tuple([z.literal("agentic_pentesting")]), caps: BudgetSchema,
};

export const FixtureEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("run.started"), ...targetFields }),
  z.strictObject({
    ...envelope, type: z.literal("run.snapshot"), ...targetFields, spent: BudgetSchema,
    findings: z.array(z.never()), installDecisions: z.array(z.never()),
    pendingApprovals: z.array(z.never()), pendingReviews: z.array(z.never()),
    terminal: TerminalSchema.optional(),
  }),
  z.strictObject({ ...envelope, type: z.literal("step"), stepId: z.string(), summary: z.string() }),
  z.strictObject({ ...envelope, type: z.literal("tool.call"), callId: z.string(), tool: z.string(), argsSummary: z.string() }),
  z.strictObject({ ...envelope, type: z.literal("tool.result"), callId: z.string(), ok: z.boolean(), summary: z.string(), artifactRef: z.string() }),
  z.strictObject({ ...envelope, type: z.literal("budget"), caps: BudgetSchema, spent: BudgetSchema }),
  z.strictObject({ ...envelope, type: z.literal("error"), message: z.string(), fatal: z.boolean() }),
  z.strictObject({
    ...envelope, type: z.literal("run.finished"), ...TerminalSchema.shape,
    confirmed: z.literal(0), needsHuman: z.literal(0), discarded: z.literal(0),
  }),
]);
export type FixtureEvent = z.infer<typeof FixtureEventSchema>;
export type EventPayload = FixtureEvent extends infer Variant
  ? Variant extends FixtureEvent ? Omit<Variant, "contractVersion" | "runId" | "seq"> : never : never;

export const AgentControlSchema = z.discriminatedUnion("type", [
  z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("stop") }),
  z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("pause") }),
  z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("resume") }),
  z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("approve"), approvalId: z.string(), decision: z.enum(["allow", "deny"]) }),
  z.strictObject({
    contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("review"),
    reviewRequestId: z.string(), findingId: z.string(), decision: z.enum(["confirm", "reject"]),
    reason: z.string(), evidenceRev: z.string(),
  }),
]);
export type AgentControl = z.infer<typeof AgentControlSchema>;
export type RunHandle = { runId: string; events: AsyncIterable<FixtureEvent>; control: (control: AgentControl) => void };

export function validateVersion(value: unknown): void {
  if (typeof value !== "object" || value === null || !("contractVersion" in value) || value.contractVersion !== CONTRACT_VERSION) {
    throw new GidorahError("contract_version_mismatch", `Expected contract ${CONTRACT_VERSION}.`);
  }
}

export function validateFixtureRun(target: string, input: unknown): RunConfig {
  validateVersion(input);
  const result = RunConfigSchema.safeParse(input);
  if (!result.success) throw new GidorahError("invalid_config", "Run configuration does not match the supported contract.");
  const config = result.data;
  if (Object.hasOwn(config, "capUsd")) throw new GidorahError("unsupported_budget", "USD metering is not implemented.");
  if (target !== FIXTURE_TARGET || config.model !== FIXTURE_MODEL || config.approvalProfile !== "closed-world"
      || config.targetKind !== "web" || config.change !== undefined
      || (config.capabilities !== undefined && (config.capabilities.length !== 1 || config.capabilities[0] !== "agentic_pentesting"))) {
    throw new GidorahError("unsupported_profile", "Only the explicit local counter fixture and fixture model are implemented. Live targets are disabled.");
  }
  if (!config.authorization.asserted || config.authorization.scopeAllowlist.length !== 1 || config.authorization.scopeAllowlist[0] !== FIXTURE_TARGET) {
    throw new GidorahError("scope_denied", "The fixture requires its exact registered scope.");
  }
  return config;
}

export function fixtureConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    contractVersion: CONTRACT_VERSION, model: FIXTURE_MODEL, targetKind: "web",
    capabilities: ["agentic_pentesting"], capSteps: 500, capTokens: 1000, capWallSec: 7200,
    approvalProfile: "closed-world", authorization: { asserted: true, scopeAllowlist: [FIXTURE_TARGET] },
    ...overrides,
  };
}

export function capsFor(config: RunConfig): Budget {
  return { tokens: config.capTokens, steps: config.capSteps, wallSec: config.capWallSec };
}

