import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, RUNTIME_VERSION, digest, sha256 } from "@ghidorah/foundation";
import { EVALUATION_CASES } from "./catalog.js";

type CaseResult = {
  id: string;
  status: "passed" | "failed" | "error" | "not_run";
  durationMs: number;
  reason: string;
};

// Repository root: apps/ghidorah/evals -> ../../..
const root = fileURLToPath(new URL("../../../", import.meta.url));
const evalsDirectory = fileURLToPath(new URL("./", import.meta.url));
const argumentsList = process.argv.slice(2);
if (argumentsList.some((argument) => !["--unit", "--list"].includes(argument))) {
  console.error("Usage: bun run eval [--unit] [--list]");
  process.exit(2);
}
const expectedIds = Array.from({ length: 100 }, (_entry, index) => `GID-${String(index + 1).padStart(3, "0")}`);
if (JSON.stringify(EVALUATION_CASES.map((entry) => entry.id)) !== JSON.stringify(expectedIds))
  throw new Error("The evaluation catalog must contain exactly GID-001 through GID-100 in order.");
const unitOnly = argumentsList.includes("--unit");
const selected = EVALUATION_CASES.filter((entry) => !unitOnly || entry.layer === "unit");
if (argumentsList.includes("--list")) {
  for (const entry of selected) console.log(`${entry.id}\t${entry.layer}\t${entry.title}\t${entry.expected}`);
  process.exit(0);
}

const skipDirectories = new Set(["node_modules", "dist", "results"]);
async function treeFingerprint(directory: string): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  for (const entry of (await readdir(resolve(root, directory), { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (skipDirectories.has(entry.name)) continue;
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(fingerprints, await treeFingerprint(relative));
    else if (entry.isFile()) fingerprints[relative] = sha256(await readFile(resolve(root, relative), "utf8"));
  }
  return fingerprints;
}
const sourceTrees = ["apps/ghidorah/src", "packages"];
const suiteTrees = ["apps/ghidorah/evals"];
async function fingerprintAll(trees: string[]): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const tree of trees) Object.assign(merged, await treeFingerprint(tree));
  return merged;
}

/** Minimal JUnit reader for Bun's reporter: one <testcase> per test, optional <failure type=...> or <skipped>. */
function parseJunit(
  xml: string,
): { name: string; seconds: number; outcome: "pass" | "assertion" | "error" | "skipped" }[] {
  const decode = (value: string): string =>
    value
      .replaceAll("&#10;", "\n")
      .replaceAll("&quot;", '"')
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  const cases: { name: string; seconds: number; outcome: "pass" | "assertion" | "error" | "skipped" }[] = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const body = match[3] ?? "";
    const name = decode(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? "");
    const seconds = Number(/\btime="([^"]*)"/.exec(attributes)?.[1] ?? "0");
    let outcome: "pass" | "assertion" | "error" | "skipped" = "pass";
    if (/<skipped\b/.test(body)) outcome = "skipped";
    else if (/<failure\b/.test(body)) {
      const type = /<failure\b[^>]*\btype="([^"]*)"/.exec(body)?.[1] ?? "";
      outcome = /AssertionError|ERR_ASSERTION/.test(type) ? "assertion" : "error";
    }
    cases.push({ name, seconds, outcome });
  }
  return cases;
}

async function runSuite(files: string[]): Promise<{ cases: ReturnType<typeof parseJunit>; runnerFailed: boolean }> {
  const scratch = await mkdtemp(resolve(tmpdir(), "ghidorah-eval-"));
  const outfile = resolve(scratch, "junit.xml");
  try {
    const child = spawn(
      process.execPath,
      [
        "test",
        "--timeout",
        "180000",
        "--max-concurrency",
        "1",
        "--reporter=junit",
        `--reporter-outfile=${outfile}`,
        ...files,
      ],
      { cwd: root, env: process.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let diagnostics = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      diagnostics += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((complete, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => complete({ code, signal }));
    }).finally(() => clearTimeout(timer));
    let xml = "";
    try {
      xml = await readFile(outfile, "utf8");
    } catch {
      console.error(diagnostics.trim().split("\n").slice(-5).join("\n"));
      return { cases: [], runnerFailed: true };
    }
    const cases = parseJunit(xml);
    // Exit code 1 with a parsable report is normal when a case fails; anything else is a runner failure.
    const runnerFailed = exit.signal !== null || (exit.code !== 0 && exit.code !== 1) || cases.length === 0;
    return { cases, runnerFailed };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const startedAt = new Date().toISOString();
const sourceFiles = await fingerprintAll(sourceTrees);
const evaluationFiles = await fingerprintAll(suiteTrees);
const lockfileSha256 = sha256(await readFile(resolve(root, "bun.lock"), "utf8"));
const results = new Map<string, CaseResult>();
let runnerErrors = 0;

const files = [
  resolve(evalsDirectory, "unit.test.ts"),
  ...(unitOnly ? [] : [resolve(evalsDirectory, "postgres.test.ts")]),
];
const { cases, runnerFailed } = await runSuite(files);
if (runnerFailed) runnerErrors += 1;
for (const entry of cases) {
  const id = /^GID-\d{3}/.exec(entry.name)?.[0];
  const definition = selected.find((candidate) => candidate.id === id);
  if (!id || !definition || results.has(id)) {
    runnerErrors += 1;
    continue;
  }
  const status: CaseResult["status"] =
    entry.outcome === "skipped"
      ? "not_run"
      : entry.outcome === "pass"
        ? "passed"
        : entry.outcome === "assertion"
          ? "failed"
          : "error";
  const reason =
    status === "passed"
      ? definition.expected
      : status === "failed"
        ? "Assertion failed. Re-run the named test file directly for local diagnostics."
        : status === "not_run"
          ? "Skipped or TODO cases cannot pass this suite."
          : "Runtime/infrastructure failure. Re-run the named test file directly; raw error payloads are not exported.";
  results.set(id, { id, status, durationMs: Math.round(entry.seconds * 1000), reason });
  console.log(`${id} ${status}: ${definition.title}`);
}

const records = selected.map((definition) => ({
  ...definition,
  ...(results.get(definition.id) ?? {
    id: definition.id,
    status: "not_run" as const,
    durationMs: 0,
    reason: "No completed case result; suite initialization or execution did not finish.",
  }),
}));
const counts = {
  scheduled: selected.length,
  passed: records.filter((entry) => entry.status === "passed").length,
  failed: records.filter((entry) => entry.status === "failed").length,
  errors: records.filter((entry) => entry.status === "error").length,
  notRun: records.filter((entry) => entry.status === "not_run").length,
  runnerErrors,
};
const unchanged =
  digest(sourceFiles) === digest(await fingerprintAll(sourceTrees)) &&
  digest(evaluationFiles) === digest(await fingerprintAll(suiteTrees)) &&
  lockfileSha256 === sha256(await readFile(resolve(root, "bun.lock"), "utf8"));
const report = {
  reportVersion: "1.1.0",
  evaluationKind: "deterministic_harness_regression",
  runId: randomUUID(),
  startedAt,
  finishedAt: new Date().toISOString(),
  runtime: `bun ${(process.versions as Record<string, string | undefined>).bun ?? "unknown"}`,
  platform: process.platform,
  contractVersion: CONTRACT_VERSION,
  runtimeVersion: RUNTIME_VERSION,
  databaseProfile: unitOnly ? "none" : (process.env.GIDORAH_DATABASE_PROFILE ?? "unset"),
  model: "synthetic fixture only",
  paidProviderCalls: 0,
  repetitions: 1,
  sourceSha256: digest(sourceFiles),
  suiteSha256: digest(evaluationFiles),
  lockfileSha256,
  sourceFiles,
  evaluationFiles,
  unchangedDuringRun: unchanged,
  accepted: counts.passed === counts.scheduled && runnerErrors === 0 && unchanged,
  counts,
  records,
  limitations: [
    "Not a model-capability benchmark",
    "Not a production security certification",
    "Does not replace the baseline SIGKILL suite",
    "Raw database errors and credentials are not exported",
  ],
};
const destination = resolve(evalsDirectory, "results", `${startedAt.replace(/[:.]/g, "-")}-${report.runId}.json`);
await mkdir(resolve(evalsDirectory, "results"), { recursive: true });
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({ accepted: report.accepted, ...counts, unchangedDuringRun: unchanged, report: destination }),
);
if (!report.accepted) process.exitCode = 1;
