import { z } from "zod";
import type { PoolClient } from "pg";
import { sha256 } from "../foundation/digest.js";
import { GidorahError } from "../foundation/errors.js";
import type { Lease } from "./journal.js";

const leaseSchema = z.strictObject({
  runId: z.uuid(),
  owner: z.uuid(),
  epoch: z.number().int().positive(),
  ttlMs: z.number().int().min(200).max(60_000),
});
const migrationId = "002-native-checkpoint-fence";
const functionBody = `
DECLARE
  execution gidorah_mastra.runs%ROWTYPE;
BEGIN
  IF TG_OP IN ('TRUNCATE', 'DELETE') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'checkpoint_delete_denied';
  END IF;
  IF NEW.run_id IS DISTINCT FROM current_setting('gidorah.run_id', true)
     OR NEW.workflow_name NOT IN ('durable-agentic-loop', 'durable-agentic-execution') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'checkpoint_scope_denied';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.workflow_name IS DISTINCT FROM NEW.workflow_name) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'checkpoint_identity_immutable';
  END IF;
  SELECT * INTO execution FROM gidorah_mastra.runs WHERE id::text = NEW.run_id FOR UPDATE;
  IF NOT FOUND OR execution.terminal IS NOT NULL
     OR execution.lease_owner::text IS DISTINCT FROM current_setting('gidorah.lease_owner', true)
     OR execution.lease_epoch::text IS DISTINCT FROM current_setting('gidorah.lease_epoch', true)
     OR execution.lease_until IS NULL OR execution.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'checkpoint_lease_lost';
  END IF;
  RETURN NEW;
END;
`;

const migration = `
CREATE FUNCTION gidorah_mastra.fence_native_checkpoint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fence$${functionBody}$fence$;
CREATE TRIGGER gidorah_checkpoint_write BEFORE INSERT OR UPDATE OR DELETE
ON gidorah_mastra_runtime.mastra_workflow_snapshot FOR EACH ROW
EXECUTE FUNCTION gidorah_mastra.fence_native_checkpoint();
CREATE TRIGGER gidorah_checkpoint_truncate BEFORE TRUNCATE
ON gidorah_mastra_runtime.mastra_workflow_snapshot FOR EACH STATEMENT
EXECUTE FUNCTION gidorah_mastra.fence_native_checkpoint();
ALTER TABLE gidorah_mastra_runtime.mastra_workflow_snapshot ENABLE ALWAYS TRIGGER gidorah_checkpoint_write;
ALTER TABLE gidorah_mastra_runtime.mastra_workflow_snapshot ENABLE ALWAYS TRIGGER gidorah_checkpoint_truncate;
`;

export function checkpointConnectionOptions(lease?: Lease): string {
  if (!lease) return "-c gidorah.run_id=none -c gidorah.lease_owner=none -c gidorah.lease_epoch=0";
  const validated = leaseSchema.parse(lease);
  return `-c gidorah.run_id=${validated.runId} -c gidorah.lease_owner=${validated.owner} -c gidorah.lease_epoch=${validated.epoch}`;
}

export async function migrateCheckpointFence(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS gidorah_mastra.migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    const existing = await client.query<{ checksum: string }>(
      "SELECT checksum FROM gidorah_mastra.migrations WHERE id=$1",
      [migrationId],
    );
    if (existing.rowCount) {
      if (existing.rows[0]!.checksum !== sha256(migration))
        throw new GidorahError("migration_mismatch", "The installed checkpoint migration does not match this build.");
    } else {
      await client.query(migration);
      await client.query("INSERT INTO gidorah_mastra.migrations(id,checksum) VALUES ($1,$2)", [
        migrationId,
        sha256(migration),
      ]);
    }
    await assertCheckpointFence(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function assertCheckpointFence(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    const result = await client.query<{ valid: boolean }>(
      `
      SELECT EXISTS (SELECT 1 FROM gidorah_mastra.migrations WHERE id=$1 AND checksum=$2)
      AND (SELECT count(*) = 2 FROM pg_trigger trigger
        JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE trigger.tgrelid = 'gidorah_mastra_runtime.mastra_workflow_snapshot'::regclass
          AND ((trigger.tgname = 'gidorah_checkpoint_write' AND trigger.tgtype = 31)
            OR (trigger.tgname = 'gidorah_checkpoint_truncate' AND trigger.tgtype = 34))
          AND trigger.tgenabled = 'A' AND NOT trigger.tgisinternal
          AND trigger.tgqual IS NULL AND trigger.tgnargs = 0 AND trigger.tgattr = ''::int2vector
          AND namespace.nspname = 'gidorah_mastra' AND procedure.proname = 'fence_native_checkpoint'
          AND procedure.prosrc = $3 AND NOT procedure.prosecdef
          AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]) AS valid`,
      [migrationId, sha256(migration), functionBody],
    );
    if (result.rows[0]?.valid) return;
  } catch {
    throw new GidorahError(
      "checkpoint_fence_unavailable",
      "Checkpoint ownership enforcement is unavailable. Initialize this dedicated database before execution.",
    );
  }
  throw new GidorahError(
    "checkpoint_fence_unavailable",
    "Checkpoint ownership enforcement is missing or changed; execution is disabled.",
  );
}
