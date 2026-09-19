import { test, type TestContext } from "node:test";
import { EVALUATION_CASES, type EvaluationCase } from "./catalog.js";

export function evaluationSuite(layer: EvaluationCase["layer"]) {
  const expected = EVALUATION_CASES.filter((entry) => entry.layer === layer);
  const registered = new Set<string>();
  return {
    check(id: string, verify: (context: TestContext) => void | Promise<void>): void {
      const entry = expected.find((candidate) => candidate.id === id);
      if (!entry || registered.has(id)) throw new Error(`Invalid or duplicate evaluation registration: ${id}`);
      registered.add(id);
      test(`${entry.id} ${entry.title}`, { timeout: 30000 }, verify);
    },
    seal(): void {
      const missing = expected.filter((entry) => !registered.has(entry.id));
      if (missing.length)
        throw new Error(`Missing evaluation implementations: ${missing.map((entry) => entry.id).join(", ")}`);
    },
  };
}
