import assert from "node:assert/strict";
import { test } from "node:test";
import { GhidorahClient } from "../../../frontend/src/client.js";

const runId = "00000000-0000-4000-8000-000000000001";
const snapshot = {
  contractVersion: "1.0.0",
  runId,
  seq: 1,
  type: "run.snapshot",
  target: "fixture://counter",
  mode: "pentest",
  capabilities: ["agentic_pentesting"],
  caps: { tokens: 100, steps: 10, wallSec: 60 },
  spent: { tokens: 0, steps: 0, wallSec: 0 },
  findings: [],
  installDecisions: [],
  pendingApprovals: [],
  pendingReviews: [],
};
const step = (seq: number) => ({
  contractVersion: "1.0.0",
  runId,
  seq,
  type: "step",
  stepId: "test",
  summary: "Synthetic.",
});
const terminal = {
  contractVersion: "1.0.0",
  runId,
  seq: 3,
  type: "run.finished",
  outcome: "completed",
  cleanupOk: true,
  confirmed: 0,
  discarded: 0,
  needsHuman: 0,
};

function client(events: unknown[], suffix = ""): GhidorahClient {
  const wire = events.map((event) => `event: record\ndata: ${JSON.stringify(event)}\n\n`).join("") + suffix;
  return new GhidorahClient(
    "https://backend.example",
    () => "synthetic",
    async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
  );
}

test("frontend consumes committed snapshots and ordered events, ignoring duplicates", async () => {
  const events = [];
  for await (const event of client([snapshot, step(2), step(2), terminal]).events(runId)) events.push(event);
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
});

test("frontend rejects sequence gaps, wrong runs and missing initial snapshots", async () => {
  for (const events of [[snapshot, step(4)], [{ ...snapshot, runId: "other" }], [step(2)]])
    await assert.rejects(async () => {
      for await (const _event of client(events).events(runId)) {
      }
    });
});

test("frontend never interprets EOF or transport failure as successful completion", async () => {
  await assert.rejects(
    async () => {
      for await (const _event of client([snapshot]).events(runId)) {
      }
    },
    { code: "stream_interrupted" },
  );
  await assert.rejects(
    async () => {
      for await (const _event of client([snapshot], "event: transport.error\ndata: {}\n\n").events(runId)) {
      }
    },
    { code: "stream_unavailable" },
  );
});

test("frontend disallows insecure remote endpoints and redirects carrying API credentials", async () => {
  assert.throws(() => new GhidorahClient("http://remote.example", () => "token"));
  let redirect: RequestRedirect | undefined;
  const sdk = new GhidorahClient(
    "https://backend.example",
    () => "token",
    async (_input, init) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302 });
    },
  );
  await assert.rejects(sdk.snapshot(runId), { status: 302 });
  assert.equal(redirect, "error");
});

test("frontend bounds JSON responses and never includes malformed response content in errors", async () => {
  for (const [body, code] of [
    ["private-response-content", "invalid_response"],
    ["x".repeat(1_048_577), "response_too_large"],
  ]) {
    const sdk = new GhidorahClient(
      "https://backend.example",
      () => "synthetic",
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
    );
    await assert.rejects(sdk.snapshot(runId), { code, message: code });
  }
});

test("frontend redacts transport errors and malformed SSE payloads", async () => {
  const sdk = new GhidorahClient(
    "https://backend.example",
    () => "synthetic",
    async () => {
      throw new Error("credential-bearing transport message");
    },
  );
  await assert.rejects(sdk.snapshot(runId), { code: "transport_unavailable", message: "transport_unavailable" });
  await assert.rejects(
    async () => {
      for await (const _event of client([], "event: record\ndata: private-invalid-json\n\n").events(runId)) {
      }
    },
    { code: "invalid_stream", message: "invalid_stream" },
  );
});
