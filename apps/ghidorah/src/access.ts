import { z } from "zod";

const identity = z.string().min(1).max(256);
export const RunAuthoritySchema = z.strictObject({
  tenantId: identity,
  actorId: identity,
  engagementId: identity,
  policyRevision: identity,
});
export type RunAuthority = z.infer<typeof RunAuthoritySchema>;
