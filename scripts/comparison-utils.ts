import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { FixtureEvent } from "../src/foundation/fixture-contract.js";

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function normalizeShared(content: string): string {
  return content
    .replaceAll("gidorah_mastra_runtime", "gidorah_graph")
    .replaceAll("gidorah_mastra", "gidorah")
    .replaceAll("gidorah-mastra-", "gidorah-")
    .replaceAll("./runtime/mastra.js", "./runtime/langchain.js")
    .trimEnd();
}

export function normalizeEvents(events: FixtureEvent[]): unknown[] {
  const callIds = new Map<string, string>();
  return events.map((event) => {
    const normalized = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    delete normalized.runId;
    if (event.type === "tool.call") callIds.set(event.callId, `call-${callIds.size}`);
    if (event.type === "tool.call" || event.type === "tool.result") {
      const callId = callIds.get(event.callId);
      if (!callId) throw new Error("A tool resulthi must have an earlier call.");
      normalized.callId = callId;
    }
    if (event.type === "budget") normalized.spent = { tokens: event.spent.tokens, steps: event.spent.steps };
    return normalized;
  });
}

export async function fingerprints(root: string): Promise<Record<string, string>> {
  const records: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    for (const entry of (await readdir(resolve(root, relative), { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === "results") continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) records[path] = sha256(await readFile(resolve(root, path), "utf8"));
    }
  }
  for (const directory of ["src", "test", "evals", "scripts"]) await visit(directory);
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "tsconfig.tests.json",
  ])
    records[path] = sha256(await readFile(resolve(root, path), "utf8"));
  return records;
}

export function parseMarker(output: string, marker: string): Record<string, unknown> {
  const lines = output.split("\n").filter((line) => line.startsWith(marker));
  if (lines.length !== 1) throw new Error("Expected exactly one completed child report.");
  return JSON.parse(lines[0]!.slice(marker.length)) as Record<string, unknown>;
}
