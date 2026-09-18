import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeEvents, normalizeShared, parseMarker, sha256 } from "../../scripts/comparison-utils.js";
import type { FixtureEvent } from "../../src/foundation/contracts.js";

test("child reports must contain exactly one valid completion marker", () => {
  assert.deepEqual(parseMarker("progress\nRESULT {\"accepted\":true}\n", "RESULT "), { accepted: true });
  assert.throws(() => parseMarker("progress only", "RESULT "));
  assert.throws(() => parseMarker("RESULT {}\nRESULT {}", "RESULT "));
  assert.throws(() => parseMarker("RESULT invalid", "RESULT "));
});

test("shared-code normalization permits namespace changes but not safety changes", () => {
  assert.equal(normalizeShared("gidorah_mastra.runs gidorah-mastra-fixture/0.1.0\n"), "gidorah.runs gidorah-fixture/0.1.0");
  assert.notEqual(normalizeShared("capSteps: 500"), normalizeShared("capSteps: 501"));
});

function fixtureEvents(runId: string, callId: string, wallSec: number): FixtureEvent[] {
  const context = { contractVersion: "1.0.0" as const, runId };
  return [
    { ...context, seq: 1, type: "budget", caps: { tokens: 1000, steps: 500, wallSec: 7200 }, spent: { tokens: 2, steps: 1, wallSec } },
    { ...context, seq: 2, type: "tool.call", callId, tool: "fixture_increment", argsSummary: "fixture" },
    { ...context, seq: 3, type: "tool.result", callId, ok: true, summary: "fixture", artifactRef: `sha256:${"a".repeat(64)}` },
  ];
}

test("event parity ignores only runtime-generated IDs and elapsed wall time", () => {
  const first = fixtureEvents("run-one", "call-one", 1);
  const second = fixtureEvents("run-two", "call-two", 9);
  assert.deepEqual(normalizeEvents(first), normalizeEvents(second));
  assert.equal(first[0]?.runId, "run-one");
  const changed = fixtureEvents("run-three", "call-three", 1);
  if (changed[0]?.type === "budget") changed[0].spent.tokens = 4;
  assert.notDeepEqual(normalizeEvents(first), normalizeEvents(changed));
});

test("event parity keeps evidence identity and refuses orphan tool results", () => {
  const first = fixtureEvents("one", "first", 1);
  const changed = fixtureEvents("two", "second", 1);
  if (changed[2]?.type === "tool.result") changed[2].artifactRef = `sha256:${"b".repeat(64)}`;
  assert.notDeepEqual(normalizeEvents(first), normalizeEvents(changed));
  assert.throws(() => normalizeEvents(first.slice(2)));
});

test("source fingerprints are stable and change when behavior changes", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(sha256("safe"), sha256("unsafe"));
});
