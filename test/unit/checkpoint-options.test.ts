import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { checkpointConnectionOptions } from "../../src/storage/checkpoint-fence.js";
import { checkpointStore } from "../../src/storage/bootstrap.js";
import { assertMastraIntegrity } from "../../src/runtime/integrity.js";

test("checkpoint connection identity is fixed per lease and cannot inject startup settings", () => {
  const lease = { runId: randomUUID(), owner: randomUUID(), epoch: 7, ttlMs: 5000 };
  assert.ok(checkpointConnectionOptions(lease).includes(`gidorah.lease_epoch=7`));
  assert.throws(() => checkpointConnectionOptions({ ...lease, owner: "bad -c search_path=public" }));
  assert.throws(() => checkpointConnectionOptions({ ...lease, epoch: -1 }));
  assert.ok(checkpointConnectionOptions().includes("gidorah.run_id=none"));
  assert.throws(() => checkpointStore({ connectionString: "postgresql://localhost/db?options=override" }), { code: "database_config" });
});

test("direct backend consumers verify the pinned runtime without relying on npm pre-hooks", async () => {
  await assertMastraIntegrity();
});
