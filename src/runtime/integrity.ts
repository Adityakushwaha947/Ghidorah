import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { sha256 } from "../foundation/digest.js";
import { GidorahError } from "../foundation/errors.js";

const require = createRequire(import.meta.url);
const acceptedBundles = {
  "agent-Dk0N0Nlg.js": "5dff0309c09c8c5a40f196882894535dadfad66aaffa9fc254b5e69b3079bb62",
  "agent-CBKrAqsZ.cjs": "e1d2cbc14b2badb02c90bf150733f1c2f4eb5fd32ac4ce9c0c98abcb360a5476",
};

export async function assertMastraIntegrity(): Promise<void> {
  try {
    const manifestPath = require.resolve("@mastra/core/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: string };
    if (manifest.version !== "1.67.0") throw new Error("version");
    for (const [name, expected] of Object.entries(acceptedBundles)) {
      if (sha256(await readFile(resolve(dirname(manifestPath), "dist", name), "utf8")) !== expected)
        throw new Error("digest");
    }
  } catch {
    throw new GidorahError(
      "runtime_integrity",
      "The installed Mastra runtime does not match the accepted recovery patch. Run patch:check before execution.",
    );
  }
}
