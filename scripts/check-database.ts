import { Pool } from "pg";
import { databaseConfig } from "../src/config.js";
import { publicError } from "../src/foundation/errors.js";

let pool: Pool | undefined;
try {
  pool = new Pool({ ...databaseConfig(), max: 1, connectionTimeoutMillis: 8000, statement_timeout: 5000, application_name: "gidorah-read-only-check" });
  const result = await pool.query("SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
  console.log(JSON.stringify({ connected: true, ...result.rows[0], credentialsPrinted: false, writesPerformed: false }));
} catch (error) {
  console.error(publicError(error));
  console.error("Start a dedicated local PostgreSQL database and set GIDORAH_DATABASE_PROFILE=local plus GIDORAH_DATABASE_URL. Remote profiles are not supported.");
  process.exitCode = 1;
} finally { await pool?.end(); }
