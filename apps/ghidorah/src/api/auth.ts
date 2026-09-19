import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RunAuthoritySchema, type RunAuthority } from "../access.js";

export const ApiPrincipalSchema = RunAuthoritySchema.extend({
  permissions: z.array(z.enum(["run:create", "run:read", "run:control"])).min(1),
  expiresAt: z.number().int().positive(),
});
export type ApiPrincipal = z.infer<typeof ApiPrincipalSchema>;
export type Authenticator = (request: Request) => Promise<ApiPrincipal>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function authorityFor(principal: ApiPrincipal): RunAuthority {
  return RunAuthoritySchema.parse({
    tenantId: principal.tenantId,
    actorId: principal.actorId,
    engagementId: principal.engagementId,
    policyRevision: principal.policyRevision,
  });
}

export function tokenAuthenticator(
  entries: readonly { tokenSha256: string; principal: ApiPrincipal }[],
  now: () => number = Date.now,
): Authenticator {
  if (!entries.length) throw new Error("At least one explicitly configured API token is required.");
  const records = entries.map((entry) => ({
    hash: Buffer.from(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(entry.tokenSha256),
      "hex",
    ),
    principal: ApiPrincipalSchema.parse(entry.principal),
  }));
  if (new Set(entries.map((entry) => entry.tokenSha256)).size !== entries.length)
    throw new Error("Duplicate API token.");
  return async (request) => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(header);
    if (!match) throw new ApiError(401, "unauthorized");
    const actual = createHash("sha256").update(match[1]!).digest();
    const record = records.find((entry) => timingSafeEqual(entry.hash, actual));
    if (!record || record.principal.expiresAt <= now()) throw new ApiError(401, "unauthorized");
    return structuredClone(record.principal);
  };
}
