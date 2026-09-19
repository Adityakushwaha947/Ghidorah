import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolConfig } from "pg";
import { CONTRACT_VERSION, canonicalJson, digest } from "@ghidorah/foundation";
import { GidorahBackend } from "../src/backend.js";
import { databaseConfig } from "../src/config.js";
import { initializeDatabase } from "../src/storage/bootstrap.js";
import { assertCheckpointFence } from "../src/storage/checkpoint-fence.js";
import { modelCounter } from "../test/helpers/model-counter.js";

const execute = promisify(execFile);
const configuration = databaseConfig();
const admin = new Pool({ ...configuration, max: 1, connectionTimeoutMillis: 8000, statement_timeout: 10000 });
const identifier = randomUUID().replaceAll("-", "");
const source = `ghidorah_drill_source_${identifier}`;
const destination = `ghidorah_drill_restore_${identifier}`;
const directory = await mkdtemp(resolve(tmpdir(), "ghidorah-restore-"));
const created: string[] = [];
const reportDirectory = fileURLToPath(new URL("../comparison/results/", import.meta.url));
const startedAt = Date.now();

function connection(database: string): PoolConfig {
  const url = new URL(configuration.connectionString!);
  url.pathname = `/${database}`;
  return { ...configuration, connectionString: url.href };
}

async function postgres(binary: "pg_dump" | "pg_restore", database: string, args: string[]): Promise<void> {
  const url = new URL(connection(database).connectionString!);
  const executable = process.env.GIDORAH_PG_BIN ? resolve(process.env.GIDORAH_PG_BIN, binary) : binary;
  await execute(executable, args, {
    env: {
      PATH: process.env.PATH,
      PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: database,
      PGSSLMODE: "disable",
      PGCONNECT_TIMEOUT: "8",
    },
    timeout: 60000,
    maxBuffer: 1_048_576,
  });
}

async function fingerprint(database: string): Promise<{ digest: string; tables: number; rows: number }> {
  const pool = new Pool({ ...connection(database), max: 1 });
  try {
    const tables = await pool.query<{ schemaname: string; tablename: string }>(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('gidorah_mastra','gidorah_mastra_runtime') ORDER BY schemaname, tablename",
    );
    const records: Record<string, string[]> = {};
    let count = 0;
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    for (const table of tables.rows) {
      const rows = await pool.query(
        `SELECT to_jsonb(record) AS value FROM ${quote(table.schemaname)}.${quote(table.tablename)} AS record LIMIT 10001`,
      );
      assert.ok(rows.rowCount! <= 10000, "The synthetic drill exceeded its row bound.");
      records[`${table.schemaname}.${table.tablename}`] = rows.rows.map((row) => canonicalJson(row.value)).sort();
      count += rows.rowCount!;
    }
    return { digest: digest(records), tables: tables.rowCount!, rows: count };
  } finally {
    await pool.end();
  }
}

async function interruptedRun(): Promise<string> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../test/helpers/gateway-crash-worker.ts", import.meta.url)), "after-result"],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        MASTRA_TELEMETRY_DISABLED: "true",
        GIDORAH_DATABASE_PROFILE: "local",
        GIDORAH_DATABASE_URL: connection(source).connectionString,
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const signal = await new Promise<NodeJS.Signals | null>((complete, reject) => {
    child.once("error", reject);
    child.once("close", (_code, signal) => complete(signal));
  }).finally(() => clearTimeout(timer));
  assert.equal(signal, "SIGKILL");
  assert.equal(output.split("PROVIDER_DISPATCH").length - 1, 1);
  const runId = /RUN:([0-9a-f-]+)/.exec(output)?.[1];
  assert.ok(runId);
  return runId;
}

let proof: Record<string, unknown> | undefined;
let failed = false;
try {
  for (const database of [source, destination]) {
    await admin.query(`CREATE DATABASE "${database}"`);
    created.push(database);
  }
  await initializeDatabase(connection(source));
  const runId = await interruptedRun();
  const before = await fingerprint(source);
  const archive = resolve(directory, "fixture.dump");
  await postgres("pg_dump", source, ["--format=custom", "--no-owner", "--no-acl", `--file=${archive}`]);
  await postgres("pg_restore", destination, [
    "--exit-on-error",
    "--no-owner",
    "--no-acl",
    `--dbname=${destination}`,
    archive,
  ]);
  const restored = await fingerprint(destination);
  assert.deepEqual(restored, before);
  await sleep(1200);
  const { profile, requests } = modelCounter();
  const backend = new GidorahBackend(connection(destination), { modelProfile: profile });
  try {
    await assertCheckpointFence(backend.journal.pool);
    assert.equal((await backend.journal.read(runId)).terminal, undefined);
    for await (const _event of backend.recover(runId, { contractVersion: CONTRACT_VERSION }).events) {
    }
    const completed = await backend.journal.read(runId);
    assert.equal(completed.terminal?.outcome, "completed");
    assert.equal(completed.spent.tokens, 48);
    assert.equal(requests.length, 2);
    const counter = await backend.journal.pool.query(
      "SELECT counter FROM gidorah_mastra.fixture_targets WHERE run_id=$1",
      [runId],
    );
    assert.equal(counter.rows[0].counter, 1);
    proof = {
      kind: "synthetic-postgres-logical-restore-v1",
      scope: "two newly created local databases; mocked provider; no customer data",
      restoredRows: restored.rows,
      restoredTables: restored.tables,
      beforeDigest: before.digest,
      restoredDigest: restored.digest,
      checkpointFenceVerified: true,
      recoveredAfterRealProcessKill: true,
      providerRequestsBeforeKill: 1,
      providerRequestsAfterRestore: requests.length,
      chargedTokens: completed.spent.tokens,
      counter: counter.rows[0].counter,
      elapsedMs: Date.now() - startedAt,
      productionApproved: false,
    };
  } finally {
    await backend.close();
  }
} catch {
  failed = true;
  process.stderr.write("The synthetic restore drill failed; no production restoration is certified.\n");
} finally {
  for (const database of created.reverse()) {
    try {
      await admin.query(`DROP DATABASE "${database}"`);
    } catch {
      failed = true;
      process.stderr.write(`Restore-drill cleanup needs inspection: ${database}\n`);
    }
  }
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
if (proof && !failed) {
  await mkdir(reportDirectory, { recursive: true });
  const report = resolve(reportDirectory, `restore-drill-${identifier}.json`);
  await writeFile(report, JSON.stringify({ ...proof, cleanupOk: true }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, productionApproved: false, report }));
} else process.exitCode = 1;
