import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { ModelCallOptions, ModelClient, ModelRequest, ModelResponse, ModelStreamEvent, ModelUsage } from "../../src/contracts/model.js";
import { canonicalJson, sha256 } from "../../src/foundation/digest.js";
import { ModelGateway, type DispatchRecord, type ModelDispatchJournal } from "../../src/model/gateway.js";
import { ModelGatewayError } from "../../src/model/errors.js";
import { modelRequest, modelResponse } from "../helpers/contract-fixtures.js";

class TestJournal implements ModelDispatchJournal {
  operations: string[] = [];
  usage: ModelUsage[] = [];
  failures: Parameters<ModelDispatchJournal["fail"]>[1][] = [];
  records = new Map<string, { record: DispatchRecord; response?: ModelResponse }>();
  tokens = 100;
  rejectAt = "";

  async reserve(record: DispatchRecord) {
    this.operations.push("reserve");
    if (this.rejectAt === "reserve") throw new Error("private storage detail");
    const existing = this.records.get(record.requestId);
    if (existing) {
      assert.deepEqual(existing.record, record);
      if (!existing.response) throw new Error("Uncertain dispatch cannot be retried.");
      return { state: "completed" as const, response: structuredClone(existing.response) };
    }
    if ([...this.records.values()].some((entry) => !entry.response)) throw new Error("A new request ID cannot bypass unresolved usage.");
    this.records.set(record.requestId, { record: structuredClone(record) });
    return { state: "reserved" as const, tokens: this.tokens };
  }

  async recordUsage(_requestId: string, usage: ModelUsage) {
    this.operations.push("usage");
    if (this.rejectAt === "usage") throw new Error("private storage detail");
    this.usage.push(structuredClone(usage));
  }

  async complete(requestId: string, response: ModelResponse) {
    this.operations.push("complete");
    if (this.rejectAt === "complete") throw new Error("private storage detail");
    this.records.get(requestId)!.response = structuredClone(response);
  }

  async fail(_requestId: string, failure: Parameters<ModelDispatchJournal["fail"]>[1]) {
    this.operations.push("fail");
    if (this.rejectAt === "fail") throw new Error("private storage detail");
    this.failures.push(structuredClone(failure));
  }
}

type Program = (request: ModelRequest, options: ModelCallOptions) => AsyncIterable<ModelStreamEvent>;
async function* events(values: unknown[]): AsyncGenerator<ModelStreamEvent> { for (const value of values) yield value as ModelStreamEvent; }
const done = (response = modelResponse()) => ({ type: "completed", requestId: response.requestId, response });
const usage = (inputTokens: number, outputTokens: number) => ({ type: "usage", requestId: "dispatch-1", usage: { inputTokens, outputTokens } });
const delta = (text: string) => ({ type: "text.delta", requestId: "dispatch-1", text });
const tool = { name: "fixture_read", description: "Read a synthetic value; no execution in this test.", schema: z.strictObject({ key: z.string().min(1) }) };

function setup(program: Program = () => events([delta("Synthetic result."), done()]), journal = new TestJournal(), limits = {}) {
  let dispatches = 0;
  let transportSignal: AbortSignal | undefined;
  const client: ModelClient = { seamVersion: "1.0.0", complete: async () => { throw new Error("Hidden non-streaming route must not run."); }, stream(request, options) {
    dispatches++;
    transportSignal = options.signal;
    journal.operations.push("dispatch");
    return program(request, options);
  } };
  const gateway = new ModelGateway([{ id: "route-1", provider: "synthetic-provider", model: "synthetic-model", responseModels: ["synthetic-model-pinned"], client, sampling: ["temperature"] }], [tool], journal, limits);
  return { gateway, journal, dispatches: () => dispatches, signal: () => transportSignal };
}

test("gateway records canonical request and route before dispatch; completion follows durable usage", async () => {
  const { gateway, journal, dispatches } = setup();
  assert.deepEqual(await gateway.complete(modelRequest(), { timeoutMs: 1000 }), modelResponse());
  assert.deepEqual(journal.operations, ["reserve", "dispatch", "usage", "complete"]);
  const record = journal.records.get("dispatch-1")!.record;
  assert.equal(record.canonicalRequest, canonicalJson(modelRequest()));
  assert.equal(record.requestDigest, sha256(record.canonicalRequest));
  assert.equal(record.provider, "synthetic-provider");
  assert.equal(record.requestedModel, "synthetic-model");
  assert.equal(journal.records.get("dispatch-1")!.response!.model, "synthetic-model-pinned");
  assert.equal(dispatches(), 1);
});

test("gateway reconciles cumulative usage without charging final totals twice", async () => {
  const { gateway, journal } = setup(() => events([usage(10, 1), usage(10, 1), usage(10, 3), done()]));
  await gateway.complete(modelRequest(), { timeoutMs: 1000 });
  assert.deepEqual(journal.usage, [{ inputTokens: 10, outputTokens: 1 }, { inputTokens: 10, outputTokens: 3 }]);
});

test("gateway reuses a committed response and never redispatches it", async () => {
  const { gateway, journal, dispatches } = setup();
  const response = await gateway.complete(modelRequest(), { timeoutMs: 1000 });
  assert.deepEqual(await gateway.complete(modelRequest(), { timeoutMs: 1000 }), response);
  assert.equal(dispatches(), 1);
  assert.equal(journal.usage.length, 1);
  await assert.rejects(gateway.complete(modelRequest({ messages: [{ role: "user", content: "changed" }] }), { timeoutMs: 1000 }), { code: "unavailable" });
  assert.equal(dispatches(), 1);
});

for (const [name, fields, code] of [
  ["wrong version", { seamVersion: "2.0.0" }, "version_mismatch"],
  ["unknown model", { model: "unapproved" }, "unsupported"],
  ["zero output budget", { maxOutputTokens: 0 }, "invalid_request"],
  ["unknown helper route", { helperModel: "hidden" }, "invalid_request"],
  ["unsupported sampling", { sampling: { seed: 10 } }, "unsupported"],
  ["nonfinite sampling", { sampling: { temperature: NaN } }, "invalid_request"],
  ["undefined sampling", { sampling: undefined }, "invalid_request"],
] as const) {
  test(`gateway rejects ${name} before journal allocation or dispatch`, async () => {
    const { gateway, journal, dispatches } = setup();
    await assert.rejects(gateway.complete({ ...modelRequest(), ...fields } as ModelRequest, { timeoutMs: 1000 }), { code });
    assert.equal(dispatches(), 0);
    assert.deepEqual(journal.operations, []);
  });
}

test("gateway rejects cyclic requests and oversized requests without dispatch", async () => {
  const { gateway, dispatches } = setup(undefined, undefined, { requestBytes: 300 });
  await assert.rejects(gateway.complete(modelRequest({ messages: [{ role: "user", content: "x".repeat(1000) }] }), { timeoutMs: 1000 }), { code: "invalid_request" });
  const input = modelRequest() as ModelRequest & { cycle?: unknown };
  input.cycle = input;
  await assert.rejects(gateway.complete(input, { timeoutMs: 1000 }), { code: "invalid_request" });
  assert.equal(dispatches(), 0);
});

test("gateway validates deadline and abort options before dispatch", async () => {
  const { gateway, journal } = setup();
  for (const timeoutMs of [0, -1, 0.5, Infinity]) await assert.rejects(gateway.complete(modelRequest(), { timeoutMs }), { code: "invalid_request" });
  await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000, signal: AbortSignal.abort("private cancellation detail") }), { code: "aborted" });
  assert.deepEqual(journal.operations, []);
});

test("gateway tool definitions cannot be replaced or widened by a request", async () => {
  const { gateway, journal } = setup();
  const registered = gateway.describeTools()[0]!;
  for (const tools of [[{ ...registered, name: "shell" }], [{ ...registered, inputSchema: {} }], [{ ...registered, description: "different instructions" }]]) {
    await assert.rejects(gateway.complete(modelRequest({ tools }), { timeoutMs: 1000 }), { code: "unsupported" });
  }
  assert.deepEqual(journal.operations, []);
});

test("gateway assembles and validates tool arguments; partial deltas never become completed calls", async () => {
  const call = { callId: "tool-1", name: tool.name, arguments: { key: "value" } };
  const final = modelResponse({ content: "", toolCalls: [call], finishReason: "tool_calls" });
  const { gateway, journal } = setup(() => events([
    { type: "tool_call.delta", requestId: "dispatch-1", callId: call.callId, name: tool.name, argumentsDelta: '{"key":' },
    { type: "tool_call.delta", requestId: "dispatch-1", callId: call.callId, argumentsDelta: '"value"}' }, done(final),
  ]));
  const received: ModelStreamEvent[] = [];
  for await (const event of gateway.stream(modelRequest({ tools: gateway.describeTools() }), { timeoutMs: 1000 })) {
    if (event.type === "completed") assert.ok(journal.records.get("dispatch-1")?.response);
    else assert.equal(journal.records.get("dispatch-1")?.response, undefined);
    received.push(event);
  }
  assert.equal(received.filter((event) => event.type === "completed").length, 1);
  assert.deepEqual(received.at(-1), done(final));
});

for (const [name, sequence] of [
  ["EOF without completion", [delta("partial")]],
  ["missing final usage", [done({ ...modelResponse(), usage: undefined } as unknown as ModelResponse)]],
  ["mismatched request", [{ ...done(), requestId: "other" }]],
  ["unapproved resolved model", [done(modelResponse({ model: "different-provider-model" }))]],
  ["decreasing usage", [usage(10, 2), usage(10, 1), done()]],
  ["final usage below last observation", [usage(10, 4), done()]],
  ["duplicate completed event", [done(), done()]],
  ["event after completion", [done(), delta("late")]],
  ["mismatched text", [delta("different"), done()]],
  ["negative usage", [usage(-1, 0), done()]],
  ["invented event", [{ type: "execute_tool_now", requestId: "dispatch-1" }]],
  ["nonfinite usage", [usage(10, Infinity), done()]],
] as const) {
  test(`gateway rejects ${name} without committing or exposing a final response`, async () => {
    const { gateway, journal, dispatches } = setup(() => events([...sequence]));
    const observed: ModelStreamEvent[] = [];
    await assert.rejects(async () => { for await (const event of gateway.stream(modelRequest(), { timeoutMs: 1000 })) observed.push(event); }, { code: name === "EOF without completion" ? "incomplete_stream" : "provider_failure" });
    assert.equal(observed.some((event) => event.type === "completed"), false);
    assert.equal(journal.records.get("dispatch-1")?.response, undefined);
    assert.equal(journal.failures[0]?.finalUsageKnown, false);
    assert.equal(dispatches(), 1);
  });
}

test("gateway preserves unknown spend and blocks a new ID while prior dispatch is uncertain", async () => {
  const { gateway, journal, dispatches } = setup(() => events([delta("partial")]));
  await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000 }), { code: "incomplete_stream" });
  assert.equal(journal.failures[0]?.observedUsage, null);
  assert.deepEqual(journal.usage, []);
  await assert.rejects(gateway.complete(modelRequest({ requestId: "new-id" }), { timeoutMs: 1000 }), { code: "unavailable" });
  assert.equal(dispatches(), 1);
});

for (const [name, call] of [
  ["unregistered name", { callId: "call", name: "shell", arguments: {} }],
  ["invalid arguments", { callId: "call", name: tool.name, arguments: { key: 3 } }],
  ["extra arguments", { callId: "call", name: tool.name, arguments: { key: "value", command: "unapproved" } }],
] as const) {
  test(`gateway rejects ${name} in finalized calls`, async () => {
    const { gateway } = setup(() => events([done(modelResponse({ content: "", finishReason: "tool_calls", toolCalls: [call] }))]));
    await assert.rejects(gateway.complete(modelRequest({ tools: gateway.describeTools() }), { timeoutMs: 1000 }), { code: "provider_failure" });
  });
}

test("gateway rejects tool-delta mismatches and invalid assembled JSON", async () => {
  for (const argumentsDelta of ['{"key":"different"}', '{"key":', 'null']) {
    const { gateway } = setup(() => events([{ type: "tool_call.delta", requestId: "dispatch-1", callId: "call", name: tool.name, argumentsDelta }, done(modelResponse({ content: "", finishReason: "tool_calls", toolCalls: [{ callId: "call", name: tool.name, arguments: { key: "value" } }] }))]));
    await assert.rejects(gateway.complete(modelRequest({ tools: gateway.describeTools() }), { timeoutMs: 1000 }), { code: "provider_failure" });
  }
});

test("a length-limited partial call is never executable", async () => {
  const { gateway } = setup(() => events([{ type: "tool_call.delta", requestId: "dispatch-1", callId: "call", name: tool.name, argumentsDelta: '{"key":' }, done(modelResponse({ content: "", finishReason: "length" }))]));
  const response = await gateway.complete(modelRequest({ tools: gateway.describeTools() }), { timeoutMs: 1000 });
  assert.equal(response.finishReason, "length");
  assert.deepEqual(response.toolCalls, []);
});

test("refusal is recorded normally and never triggers retry or a fallback provider", async () => {
  const { gateway, journal, dispatches } = setup(() => events([done(modelResponse({ content: "Synthetic refusal.", finishReason: "refusal" }))]));
  const response = await gateway.complete(modelRequest(), { timeoutMs: 1000 });
  assert.equal(response.finishReason, "refusal");
  assert.equal(dispatches(), 1);
  assert.equal(journal.failures.length, 0);
  assert.deepEqual(response.toolCalls, []);
});

test("timeout bounds an uncooperative provider iterator and aborts its transport", async () => {
  const { gateway, journal, signal } = setup(async function* () { await new Promise(() => undefined); });
  await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 20 }), { code: "timeout", requestId: "dispatch-1" });
  assert.equal(signal()?.aborted, true);
  assert.equal(journal.failures[0]?.code, "timeout");
});

test("external cancellation is separate from timeout and does not expose abort reasons", async () => {
  const controller = new AbortController();
  const { gateway, journal, signal } = setup(async function* () { controller.abort("private cancellation payload"); await new Promise(() => undefined); });
  await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000, signal: controller.signal }), (error: unknown) => error instanceof ModelGatewayError && error.code === "aborted" && !error.message.includes("private"));
  assert.equal(signal()?.aborted, true);
  assert.equal(journal.failures[0]?.observedUsage, null);
});

test("abandoning a stream cancels transport and records uncertain accounting", async () => {
  const { gateway, journal, signal } = setup();
  const iterator = gateway.stream(modelRequest(), { timeoutMs: 1000 });
  assert.equal((await iterator.next()).value?.type, "text.delta");
  await iterator.return(undefined);
  assert.equal(signal()?.aborted, true);
  assert.equal(journal.failures[0]?.code, "aborted");
  assert.equal(journal.records.get("dispatch-1")?.response, undefined);
});

test("only one provider dispatch is in flight on a gateway", async () => {
  const { gateway, dispatches } = setup();
  const iterator = gateway.stream(modelRequest(), { timeoutMs: 1000 });
  await iterator.next();
  await assert.rejects(gateway.complete(modelRequest({ requestId: "another" }), { timeoutMs: 1000 }), { code: "unavailable" });
  assert.equal(dispatches(), 1);
  await iterator.return(undefined);
});

for (const phase of ["reserve", "usage", "complete", "fail"]) {
  test(`mandatory ${phase} journal failure never returns a successful response`, async () => {
    const journal = new TestJournal();
    journal.rejectAt = phase;
    const { gateway, dispatches } = setup(() => events(phase === "fail" ? [] : [done()]), journal);
    await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000 }), { code: "unavailable" });
    assert.equal(journal.records.get("dispatch-1")?.response, undefined);
    assert.equal(dispatches(), phase === "reserve" ? 0 : 1);
  });
}

test("usage above reservation is retained but cannot authorize completion", async () => {
  const journal = new TestJournal();
  journal.tokens = 20;
  const { gateway } = setup(() => events([done(modelResponse({ usage: { inputTokens: 19, outputTokens: 3 } }))]), journal);
  await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000 }), { code: "provider_failure" });
  assert.deepEqual(journal.usage, [{ inputTokens: 19, outputTokens: 3 }]);
  assert.equal(journal.records.get("dispatch-1")?.response, undefined);
});

test("insufficient reservation prevents dispatch", async () => {
  const journal = new TestJournal();
  journal.tokens = 1;
  const { gateway, dispatches } = setup(undefined, journal);
  await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000 }), { code: "unavailable" });
  assert.equal(dispatches(), 0);
});

test("stream event and byte limits bound provider output", async () => {
  for (const limits of [{ events: 1 }, { streamBytes: 20 }]) {
    const { gateway } = setup(undefined, undefined, limits);
    await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000 }), { code: "provider_failure" });
  }
});

test("provider failures are sanitized, not retried, and preserve already-observed usage", async () => {
  const { gateway, journal, dispatches } = setup(async function* () {
    yield usage(10, 1) as ModelStreamEvent;
    throw new Error("private provider response with credentials");
  });
  await assert.rejects(gateway.complete(modelRequest(), { timeoutMs: 1000 }), (error: unknown) => error instanceof ModelGatewayError && error.code === "provider_failure" && !error.message.includes("credentials"));
  assert.deepEqual(journal.failures[0]?.observedUsage, { inputTokens: 10, outputTokens: 1 });
  assert.equal(dispatches(), 1);
});

test("caller mutation after admission cannot change the recorded or dispatched request", async () => {
  const request = modelRequest();
  const { gateway, journal } = setup((dispatched) => {
    assert.equal(dispatched.messages[0]?.content, "Synthetic fixture only.");
    return events([done()]);
  });
  const pending = gateway.complete(request, { timeoutMs: 1000 });
  request.messages[0]!.content = "mutated";
  await pending;
  assert.equal(JSON.parse(journal.records.get("dispatch-1")!.record.canonicalRequest).messages[0].content, "Synthetic fixture only.");
});
