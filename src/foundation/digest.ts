import { createHash } from "node:crypto";
import { GidorahError } from "./errors.js";

export function canonicalJson(value: unknown): string {
  const ancestors = new WeakSet<object>();
  function encode(entry: unknown): string {
    if (entry === null || typeof entry === "boolean" || typeof entry === "string") return JSON.stringify(entry);
    if (typeof entry === "number" && Number.isFinite(entry)) return JSON.stringify(entry);
    if (
      typeof entry === "object" &&
      entry !== null &&
      (Array.isArray(entry) || Object.getPrototypeOf(entry) === Object.prototype)
    ) {
      if (ancestors.has(entry)) throw new GidorahError("invalid_json", "Cyclic values are not JSON.");
      ancestors.add(entry);
      try {
        if (Array.isArray(entry)) return `[${Array.from(entry, encode).join(",")}]`;
        return `{${Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
          .join(",")}}`;
      } finally {
        ancestors.delete(entry);
      }
    }
    throw new GidorahError("invalid_json", "Only finite JSON values are accepted.");
  }
  return encode(value);
}

export function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}
