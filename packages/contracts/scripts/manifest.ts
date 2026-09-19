import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
import { z } from "zod";
import * as contracts from "../src/index.js";
import { canonicalJson, sha256 } from "@ghidorah/foundation";

const schemas = Object.fromEntries(
  Object.entries(contracts)
    .filter(([name, value]) => name.endsWith("Schema") && value instanceof z.ZodType)
    .map(([name, value]) => [name, z.toJSONSchema(value as z.ZodType, { target: "draft-2020-12" })]),
);
const bundle = {
  contractVersion: contracts.CONTRACT_VERSION,
  seams: contracts.SEAM_VERSION,
  validation:
    "Structural JSON Schemas only. Run the shared TypeScript validators and contract fixtures for semantic checks; backend authority and artifact validation remain mandatory.",
  schemas,
};
const sourceFiles: Record<string, string> = {};
for (const name of (await readdir(resolve(packageRoot, "src"))).sort()) {
  if (name.endsWith(".ts")) sourceFiles[name] = sha256(await readFile(resolve(packageRoot, "src", name), "utf8"));
}
const fingerprint = {
  contractVersion: contracts.CONTRACT_VERSION,
  seams: contracts.SEAM_VERSION,
  schemaSha256: sha256(canonicalJson(bundle)),
  implementationSha256: sha256(canonicalJson(sourceFiles)),
  canonicalEncoderSha256: sha256(await readFile(resolve(packageRoot, "../foundation/src/digest.ts"), "utf8")),
  schemas: Object.keys(schemas).sort(),
};
const mode = process.argv[2] ?? "--check";
if (mode === "--fingerprint") process.stdout.write(`${JSON.stringify(fingerprint, null, 2)}\n`);
else {
  if (!["--check", "--emit"].includes(mode)) throw new Error("Expected --check, --emit or --fingerprint.");
  const expected = JSON.parse(await readFile(resolve(packageRoot, "manifest.json"), "utf8"));
  if (canonicalJson(expected) !== canonicalJson(fingerprint))
    throw new Error(
      "Shared contract fingerprint changed. Review compatibility and versioning before updating packages/contracts/manifest.json.",
    );
  if (mode === "--emit") {
    await mkdir(resolve(packageRoot, "dist"), { recursive: true });
    await writeFile(resolve(packageRoot, "dist/schema.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  }
  process.stdout.write(`Shared contracts verified: ${fingerprint.schemaSha256}\n`);
}
