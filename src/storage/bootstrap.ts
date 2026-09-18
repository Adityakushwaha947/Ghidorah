import { Pool, type PoolConfig } from "pg";
import { PostgresStore } from "@mastra/pg";
import { noopLogger } from "@mastra/core/logger";
import { GidorahError } from "../foundation/errors.js";
import { PostgresJournal } from "./journal.js";

export const GRAPH_SCHEMA = "gidorah_mastra_runtime";
const SCHEMA_MARKER = "gidorah-mastra-owned-fixture-v1";
export type CheckpointStore = { storage: PostgresStore; end: () => Promise<void> };

export function checkpointStore(connection: PoolConfig, initialize = false): CheckpointStore {
  const pool = new Pool({ ...connection, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 10000, application_name: "gidorah-mastra-checkpoints" });
  const storage = new PostgresStore({ id: "gidorah-mastra-fixture", pool, schemaName: GRAPH_SCHEMA, disableInit: !initialize });
  storage.__setLogger(noopLogger);
  return { storage, end: () => pool.end() };
}

export async function initializeDatabase(connection: PoolConfig): Promise<void> {
  const journal = new PostgresJournal(connection);
  const checkpoint = checkpointStore(connection, true);
  const client = await journal.pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('gidorah-mastra-bootstrap-v1'))");
    locked = true;
    for (const name of ["gidorah_mastra", GRAPH_SCHEMA]) {
      const existing = await client.query("SELECT obj_description(oid, 'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1", [name]);
      if (existing.rowCount && existing.rows[0].marker !== SCHEMA_MARKER) throw new GidorahError("schema_conflict", "An existing unmarked schema must not be adopted or modified automatically.");
    }
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA IF NOT EXISTS gidorah_mastra; COMMENT ON SCHEMA gidorah_mastra IS 'gidorah-mastra-owned-fixture-v1'; CREATE SCHEMA IF NOT EXISTS gidorah_mastra_runtime; COMMENT ON SCHEMA gidorah_mastra_runtime IS 'gidorah-mastra-owned-fixture-v1';");
    await client.query("COMMIT");
    await journal.setup();
    await checkpoint.storage.init();
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('gidorah-mastra-bootstrap-v1'))").catch(() => undefined);
    client.release();
    await checkpoint.end();
    await journal.close();
  }
}
