import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { tokenAuthenticator } from "../../src/api/auth.js";

const token = "fixture_token_".repeat(4);
const principal = {
  tenantId: "tenant",
  actorId: "actor",
  engagementId: "engagement",
  policyRevision: "v1",
  permissions: ["run:read" as const],
  expiresAt: 2000,
};

test("API authentication checks hashed credentials and expiry; authority is not taken from headers", async () => {
  const authenticate = tokenAuthenticator(
    [{ tokenSha256: createHash("sha256").update(token).digest("hex"), principal }],
    () => 1000,
  );
  const request = new Request("http://localhost", {
    headers: { authorization: `Bearer ${token}`, "x-tenant-id": "attacker" },
  });
  assert.deepEqual(await authenticate(request), principal);
  await assert.rejects(authenticate(new Request("http://localhost")), { status: 401 });
  await assert.rejects(
    authenticate(new Request("http://localhost", { headers: { authorization: `Bearer ${"x".repeat(43)}` } })),
    { status: 401 },
  );
  const expired = tokenAuthenticator(
    [{ tokenSha256: createHash("sha256").update(token).digest("hex"), principal }],
    () => 2001,
  );
  await assert.rejects(expired(request), { status: 401 });
});

test("API auth configuration and returned principals cannot mutate trusted authority", async () => {
  const entry = {
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    principal: structuredClone(principal),
  };
  const authenticate = tokenAuthenticator([entry], () => 1000);
  entry.principal.tenantId = "changed";
  const request = new Request("http://localhost", { headers: { authorization: `Bearer ${token}` } });
  const first = await authenticate(request);
  first.tenantId = "changed-again";
  assert.equal((await authenticate(request)).tenantId, "tenant");
  assert.throws(() => tokenAuthenticator([]));
  assert.throws(() => tokenAuthenticator([entry, entry]));
});
