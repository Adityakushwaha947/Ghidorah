import { OpenRouterClient } from "@ghidorah/model";
import { counterModelProfile } from "../../src/runtime/model-profile.js";
import { byteInputBound } from "../../src/storage/model-dispatch-journal.js";

export function modelCounter(options: { mode?: "normal" | "refusal" | "disconnect"; onRequest?: () => void } = {}) {
  const requests: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_input, init) => {
    options.onRequest?.();
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const ordinal = body.messages.filter((message: { role: string }) => message.role === "tool").length;
    const name = ordinal === 0 ? "fixture_increment" : ordinal === 1 ? "fixture_read" : undefined;
    const delta = name
      ? { tool_calls: [{ index: 0, id: `provider-call-${ordinal}`, function: { name, arguments: "{}" } }] }
      : { content: "Counter fixture finished. No security assessment." };
    const frames = [
      { model: "test/counter", choices: [{ delta: options.mode === "refusal" ? { content: "Declined." } : delta }] },
      {
        choices: [
          { delta: {}, finish_reason: options.mode === "refusal" ? "content_filter" : name ? "tool_calls" : "stop" },
        ],
      },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
    ];
    const bodyText = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    return new Response(options.mode === "disconnect" ? bodyText : `${bodyText}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const client = new OpenRouterClient({
    apiKey: "synthetic-test-credential",
    model: "test/counter",
    upstreams: ["test"],
    fetch: transport,
  });
  const profile = counterModelProfile({
    route: {
      id: "synthetic-http-counter-v1",
      provider: "openrouter",
      model: "test/counter",
      responseModels: ["test/counter"],
      sampling: [],
      client,
    },
    inputBound: byteInputBound,
    inputBoundRevision: "development-byte-bound-v1",
    maxOutputTokens: 64,
    timeoutMs: 5000,
  });
  return { profile, requests };
}
