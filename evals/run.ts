import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";
import { digest, sha256 } from "../src/foundation/digest.js";
import { CONTRACT_VERSION, RUNTIME_VERSION } from "../src/foundation/contracts.js";
import { EVALUATION_CASES } from "./catalog.js";

type CaseResult = {
  id: string; status: "passed" | "failed" | "error" | "not_run";
  durationMs: number; reason: string;
};

const root = fileURLToPath(new URL("../", import.meta.url));
const argumentsList = process.argv.slice(2);
if (argumentsList.some((argument) => !["--unit", "--list"].includes(argument))) {
  console.error("Usage: npm run eval -- [--unit] [--list]");
  process.exit(2);
}
const expectedIds = Array.from({ length: 100 }, (_entry, index) => `GID-${String(index + 1).padStart(3, "0")}`);
if (JSON.stringify(EVALUATION_CASES.map((entry) => entry.id)) !== JSON.stringify(expectedIds)) throw new Error("The evaluation catalog must contain exactly GID-001 through GID-100 in order.");
const unitOnly = argumentsList.includes("--unit");
const selected = EVALUATION_CASES.filter((entry) => !unitOnly || entry.layer === "unit");
if (argumentsList.includes("--list")) {
  for (const entry of selected) console.log(`${entry.id}\t${entry.layer}\t${entry.title}\t${entry.expected}`);
  process.exit(0);
}

async function treeFingerprint(directory: string): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  for (const entry of (await readdir(resolve(root, directory), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (directory === "evals" && entry.name === "results") continue;
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(fingerprints, await treeFingerprint(relative));
    else if (entry.isFile()) fingerprints[relative] = sha256(await readFile(resolve(root, relative), "utf8"));
  }
  return fingerprints;
}

function assertionFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && current.code === "ERR_ASSERTION") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

const startedAt = new Date().toISOString();
const sourceFiles = await treeFingerprint("src");
const evaluationFiles = await treeFingerprint("evals");
const packageLockSha256 = sha256(await readFile(resolve(root, "package-lock.json"), "utf8"));
const results = new Map<string, CaseResult>();
let runnerErrors = 0;
const stream = run({
  files: [resolve(root, "evals/unit.test.ts"), ...(unitOnly ? [] : [resolve(root, "evals/postgres.test.ts")])],
  cwd: root, concurrency: 1, isolation: "process", execArgv: ["--import", "tsx"],
  timeout: 180000, signal: AbortSignal.timeout(600000),
});

try {
  for await (const event of stream) {
    if (event.type === "test:summary" && !event.data.success) runnerErrors += 1;
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const id = /^GID-\d{3}/.exec(event.data.name)?.[0];
    const definition = selected.find((entry) => entry.id === id);
    if (!id || !definition || results.has(id)) {
      runnerErrors += 1;
      continue;
    }
    const skipped = event.data.skip || event.data.todo;
    const status: CaseResult["status"] = skipped ? "not_run" : event.type === "test:pass" ? "passed" : assertionFailure(event.data.details.error) ? "failed" : "error";
    const reason = status === "passed" ? definition.expected : status === "failed"
      ? "Assertion failed. Re-run the named test file directly for local diagnostics."
      : status === "not_run" ? "Skipped or TODO cases cannot pass this suite."
      : "Runtime/infrastructure failure. Re-run the named test file directly; raw error payloads are not exported.";
    results.set(id, { id, status, durationMs: event.data.details.duration_ms, reason });
    console.log(`${id} ${status}: ${definition.title}`);
  }
} catch {
  runnerErrors += 1;
}

const records = selected.map((definition) => ({
  ...definition,
  ...(results.get(definition.id) ?? { id: definition.id, status: "not_run" as const, durationMs: 0, reason: "No completed case result; suite initialization or execution did not finish." }),
}));
const counts = {
  scheduled: selected.length,
  passed: records.filter((entry) => entry.status === "passed").length,
  failed: records.filter((entry) => entry.status === "failed").length,
  errors: records.filter((entry) => entry.status === "error").length,
  notRun: records.filter((entry) => entry.status === "not_run").length,
  runnerErrors,
};
const unchanged = digest(sourceFiles) === digest(await treeFingerprint("src"))
  && digest(evaluationFiles) === digest(await treeFingerprint("evals"))
  && packageLockSha256 === sha256(await readFile(resolve(root, "package-lock.json"), "utf8"));
const report = {
  reportVersion: "1.0.0", evaluationKind: "deterministic_harness_regression", runId: randomUUID(),
  startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  contractVersion: CONTRACT_VERSION, runtimeVersion: RUNTIME_VERSION,
  databaseProfile: unitOnly ? "none" : process.env.GIDORAH_DATABASE_PROFILE ?? "unset",
  model: "synthetic fixture only", paidProviderCalls: 0, repetitions: 1,
  sourceSha256: digest(sourceFiles), suiteSha256: digest(evaluationFiles), packageLockSha256,
  sourceFiles, evaluationFiles, unchangedDuringRun: unchanged,
  accepted: counts.passed === counts.scheduled && runnerErrors === 0 && unchanged,
  counts, records,
  limitations: ["Not a model-capability benchmark", "Not a production security certification", "Does not replace the baseline SIGKILL suite", "Raw database errors and credentials are not exported"],
};
const destination = resolve(root, "evals/results", `${startedAt.replace(/[:.]/g, "-")}-${report.runId}.json`);
await mkdir(resolve(root, "evals/results"), { recursive: true });
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ accepted: report.accepted, ...counts, unchangedDuringRun: unchanged, report: destination }));
if (!report.accepted) process.exitCode = 1;
