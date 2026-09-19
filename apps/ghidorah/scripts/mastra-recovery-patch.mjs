import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const patchId = "gidorah-mastra-1.67.0-recovery-v1";
export const coreDirectory = resolve(createRequire(import.meta.url).resolve("@mastra/core/package.json"), "..");
export const bundles = [
  {
    path: "dist/agent-Dk0N0Nlg.js",
    original: "f6dfdfd0f9576477fe278ffb1768c5903982eaf8bdf3da085b35e4f8b6a90ced",
    patched: "5dff0309c09c8c5a40f196882894535dadfad66aaffa9fc254b5e69b3079bb62",
  },
  {
    path: "dist/agent-CBKrAqsZ.cjs",
    original: "6997ebed7091b86229a3c31ce632f2fb3466af33f474bfac4e5424193eca9720",
    patched: "e1d2cbc14b2badb02c90bf150733f1c2f4eb5fd32ac4ce9c0c98abcb360a5476",
  },
];
export const replacements = [
  {
    before: "\t\t\tprevOutput: getResumeStepPrevOutput({\n\t\t\t\tisResumedStep,\n\t\t\t\tstepId,",
    after:
      "\t\t\tprevOutput: getResumeStepPrevOutput({\n\t\t\t\tisResumedStep: isResumedStep || !!restart?.activeStepsPath?.[stepId],\n\t\t\t\tstepId,",
  },
  {
    before: '\t\tif ("output" in pruned) pruned.output = stripRunningHistoryFields(pruned.output);',
    after:
      '\t\tif ("output" in pruned && key !== DurableStepIds.LLM_EXECUTION) pruned.output = stripRunningHistoryFields(pruned.output);',
  },
];

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function prepareBundle(content, bundle) {
  const currentHash = hash(content);
  if (currentHash === bundle.patched) return content;
  if (currentHash !== bundle.original) throw new Error(`Unrecognized Mastra bundle: ${bundle.path}`);
  let patched = content;
  for (const { before, after } of replacements) {
    if (patched.split(before).length !== 2) throw new Error(`Ambiguous patch target: ${bundle.path}`);
    patched = patched.replace(before, after);
  }
  if (!patched.endsWith("\n")) patched += "\n";
  if (hash(patched) !== bundle.patched) throw new Error(`Unexpected patch result: ${bundle.path}`);
  return patched;
}

export async function managePatch({ directory = coreDirectory, check = false } = {}) {
  const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  if (metadata.name !== "@mastra/core" || metadata.version !== "1.67.0")
    throw new Error("Recovery patch requires exactly @mastra/core 1.67.0; review upgrades explicitly.");
  const prepared = [];
  for (const bundle of bundles) {
    const content = await readFile(resolve(directory, bundle.path), "utf8");
    const patched = prepareBundle(content, bundle);
    if (check && content !== patched)
      throw new Error("Mastra recovery patch is missing. Run bun run patch:mastra before execution.");
    prepared.push({ bundle, content, patched });
  }
  for (const { bundle, content, patched } of prepared) {
    if (!check && content !== patched) await writeFile(resolve(directory, bundle.path), patched);
  }
  for (const { bundle } of prepared) {
    if (hash(await readFile(resolve(directory, bundle.path))) !== bundle.patched)
      throw new Error(`Patch verification failed: ${bundle.path}`);
  }
  return {
    id: patchId,
    version: metadata.version,
    verified: true,
    files: bundles.map((bundle) => ({ path: bundle.path, sha256: bundle.patched })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--check"))
      throw new Error("Usage: bun apps/ghidorah/scripts/mastra-recovery-patch.mjs [--check]");
    console.log(JSON.stringify(await managePatch({ check: process.argv.includes("--check") })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mastra patch verification failed.");
    process.exitCode = 1;
  }
}
