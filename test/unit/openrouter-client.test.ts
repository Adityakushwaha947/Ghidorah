import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelStreamEvent } from "../../src/contracts/model.js";
import { OpenRouterClient } from "../../src/model/openrouter.js";
import { modelRequest } from "../helpers/contract-fixtures.js";

const MODEL = "z-ai/glm-4.7";

function sse(lines: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

const data = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}`;
const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  data({ id: "gen-1", model: MODEL, choices: [{ delta, finish_reason: finish }], ...extra });
const usageChunk = (prompt_tokens: number, completion_tokens: number) =>
  data({
    id: "gen-1",
    model: MODEL,
    choices: [{ delta: { content: "" }, finish_reason: null }],
    usage: { prompt_tokens, completion_tokens },
  });

function client(program: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return program(input, init);
  };
  return { client: new OpenRouterClient({ apiKey: "test-key", model: MODEL, fetch: transport }), calls };
}

const request = () => modelRequest({ model: MODEL, requestId: "dispatch-1" });

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("text stream: comments are skipped, deltas forwarded, final usage frame and DONE finalize the response", async () => {
  const { client: router, calls } = client(() =>
    sse([
      ": OPENROUTER PROCESSING",
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      ": OPENROUTER PROCESSING",
      chunk({ content: "lo" }, "stop"),
      usageChunk(12, 2),
      "data: [DONE]",
    ]),
  );
  const events = await collect(router.stream(request(), { timeoutMs: 5000 }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["text.delta", "text.delta", "usage", "completed"],
  );
  const completed = events.at(-1)!;
  assert.equal(completed.type, "completed");
  if (completed.type !== "completed") return;
  assert.deepEqual(completed.response, {
    requestId: "dispatch-1",
    model: MODEL,
    content: "Hello",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 2 },
  });
  assert.equal(calls.length, 1, "exactly one HTTP request, no retries");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, true);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.max_tokens, request().maxOutputTokens);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-key");
});

test("tool call split across chunks is assembled with its index and parsed arguments", async () => {
  const { client: router, calls } = client(() =>
    sse([
      chunk({
        tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "fixture_read", arguments: "" } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"key":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"counter"}' } }] }, "tool_calls"),
      usageChunk(40, 9),
      "data: [DONE]",
    ]),
  );
  const input = modelRequest({
    model: MODEL,
    tools: [
      {
        name: "fixture_read",
        description: "Read",
        inputSchema: { type: "object", properties: { key: { type: "string" } } },
      },
    ],
  });
  const events = await collect(router.stream(input, { timeoutMs: 5000 }));
  const deltas = events.filter((event) => event.type === "tool_call.delta");
  assert.equal(deltas.length, 3);
  assert.deepEqual(deltas[0], {
    type: "tool_call.delta",
    requestId: "dispatch-1",
    callId: "call_a",
    name: "fixture_read",
    argumentsDelta: "",
  });
  const completed = events.at(-1)!;
  if (completed.type !== "completed") assert.fail("expected completion");
  assert.deepEqual(completed.response.toolCalls, [
    { callId: "call_a", name: "fixture_read", arguments: { key: "counter" } },
  ]);
  assert.equal(completed.response.finishReason, "tool_calls");
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "fixture_read");
  assert.equal(body.tool_choice, "auto");
});

test("assistant tool calls and tool results are mapped to the wire shape", async () => {
  const { client: router, calls } = client(() =>
    sse([chunk({ content: "ok" }, "stop"), usageChunk(1, 1), "data: [DONE]"]),
  );
  const input = modelRequest({
    model: MODEL,
    tools: [{ name: "fixture_read", description: "Read", inputSchema: { type: "object" } }],
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "fixture_read", arguments: { key: "k" } }] },
      { role: "tool", callId: "c1", content: "1", isError: false },
    ],
  });
  await collect(router.stream(input, { timeoutMs: 5000 }));
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.messages[2], {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "fixture_read", arguments: '{"key":"k"}' } }],
  });
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: "1" });
});

test("mid-stream error chunk is a provider failure", async () => {
  const { client: router } = client(() =>
    sse([
      chunk({ content: "partial" }),
      data({ error: { code: 502, message: "upstream" }, choices: [{ delta: {}, finish_reason: "error" }] }),
    ]),
  );
  await assert.rejects(collect(router.stream(request(), { timeoutMs: 5000 })), { code: "provider_failure" });
});

test("a stream without a final usage frame cannot complete", async () => {
  const { client: router } = client(() => sse([chunk({ content: "done" }, "stop"), "data: [DONE]"]));
  await assert.rejects(collect(router.stream(request(), { timeoutMs: 5000 })), { code: "provider_failure" });
});

test("a stream that ends without DONE or finish_reason is incomplete", async () => {
  const { client: router } = client(() => sse([chunk({ content: "half" })]));
  await assert.rejects(collect(router.stream(request(), { timeoutMs: 5000 })), { code: "incomplete_stream" });
});

test("non-2xx responses are sanitized provider failures and never retried", async () => {
  const { client: router, calls } = client(
    () => new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }),
  );
  await assert.rejects(collect(router.stream(request(), { timeoutMs: 5000 })), (error: Error) => {
    assert.equal((error as unknown as { code: string }).code, "provider_failure");
    assert.ok(!error.message.includes("API key"));
    return true;
  });
  assert.equal(calls.length, 1);
});

test("length truncation drops partial tool calls and reports length", async () => {
  const { client: router } = client(() =>
    sse([
      chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "fixture_read", arguments: '{"key":' } }] }),
      chunk({}, "length"),
      usageChunk(5, 64),
      "data: [DONE]",
    ]),
  );
  const events = await collect(router.stream(request(), { timeoutMs: 5000 }));
  const completed = events.at(-1)!;
  if (completed.type !== "completed") assert.fail("expected completion");
  assert.equal(completed.response.finishReason, "length");
  assert.deepEqual(completed.response.toolCalls, []);
});

test("caller abort surfaces as aborted and cancels the transport", async () => {
  let transportSignal: AbortSignal | undefined;
  const { client: router } = client((_input, init) => {
    transportSignal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${chunk({ content: "slow" })}\n`));
      },
    });
    return new Response(body, { status: 200 });
  });
  const controller = new AbortController();
  const iterator = router.stream(request(), { timeoutMs: 5000, signal: controller.signal })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "text.delta");
  controller.abort();
  await assert.rejects(iterator.next(), { code: "aborted" });
  assert.equal(transportSignal?.aborted, true);
});

test("pinned upstreams are sent as a provider order with fallbacks disabled", async () => {
  const calls: RequestInit[] = [];
  const transport: typeof fetch = async (_input, init) => {
    calls.push(init ?? {});
    return sse([chunk({ content: "ok" }, "stop"), usageChunk(1, 1), "data: [DONE]"]);
  };
  const pinned = new OpenRouterClient({ apiKey: "k", model: MODEL, fetch: transport, upstreams: ["Venice"] });
  await collect(pinned.stream(request(), { timeoutMs: 5000 }));
  const body = JSON.parse(String(calls[0]!.body));
  assert.deepEqual(body.provider, { order: ["Venice"], allow_fallbacks: false, require_parameters: true });
  const unpinned = new OpenRouterClient({ apiKey: "k", model: MODEL, fetch: transport });
  await collect(unpinned.stream(request(), { timeoutMs: 5000 }));
  assert.equal(JSON.parse(String(calls[1]!.body)).provider, undefined);
});

test("the client refuses a request for a model it is not pinned to", async () => {
  const { client: router, calls } = client(() => sse([]));
  await assert.rejects(collect(router.stream(modelRequest({ model: "other/model" }), { timeoutMs: 5000 })), {
    code: "unsupported",
  });
  assert.equal(calls.length, 0);
});
