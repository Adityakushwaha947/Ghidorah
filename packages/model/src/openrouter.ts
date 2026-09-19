import { SEAM_VERSION } from "@ghidorah/contracts";
import type {
  ModelCallOptions,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
} from "@ghidorah/contracts";
import { ModelGatewayError } from "./errors.js";

export type OpenRouterClientOptions = {
  /** Bearer credential. Supplied by the deployment's secret mechanism; this module never reads files or env. */
  apiKey: string;
  /** The exact OpenRouter model identifier this client is pinned to, for example "z-ai/glm-4.7". */
  model: string;
  baseUrl?: string;
  /** Injectable transport for tests. Defaults to the global fetch. No retries are ever performed. */
  fetch?: typeof fetch;
  referer?: string;
  title?: string;
  /**
   * Upstream providers OpenRouter may route to, in order, with fallbacks disabled. OpenRouter otherwise load-balances
   * a model across several upstreams whose behaviour differs; one was observed ignoring max_tokens. Pinning keeps
   * the route deterministic and satisfies the no-hidden-fallback rule. Also requires upstreams to honour every
   * request parameter.
   */
  upstreams?: readonly string[];
};

type Chunk = {
  id?: string;
  model?: string;
  error?: unknown;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

const finishReasons: Record<string, ModelResponse["finishReason"]> = {
  stop: "stop",
  tool_calls: "tool_calls",
  length: "length",
  content_filter: "refusal",
};

/**
 * OpenRouter Chat Completions adapter for the ModelClient seam. One streaming HTTP request per call, no SDK, no
 * retries, no provider fallback. Text and argument deltas are forwarded as uncommitted preview; the single
 * `completed` event carries the finalized response with the provider's final usage frame.
 */
export class OpenRouterClient implements ModelClient {
  readonly seamVersion = SEAM_VERSION.model;
  private readonly transport: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenRouterClientOptions) {
    if (
      !options.apiKey ||
      !options.model ||
      !options.upstreams?.length ||
      options.upstreams.some((entry) => !entry.trim()) ||
      new Set(options.upstreams).size !== options.upstreams.length
    )
      throw new ModelGatewayError("unsupported", "configuration");
    this.transport = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
    if (this.baseUrl !== "https://openrouter.ai/api/v1") throw new ModelGatewayError("unsupported", "configuration");
    this.options = { ...options, upstreams: Object.freeze([...options.upstreams]) };
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse> {
    for await (const event of this.stream(request, options)) if (event.type === "completed") return event.response;
    throw new ModelGatewayError("incomplete_stream", request.requestId);
  }

  private body(request: ModelRequest): string {
    return JSON.stringify({
      model: this.options.model,
      stream: true,
      usage: { include: true },
      max_tokens: request.maxOutputTokens,
      ...(this.options.upstreams?.length
        ? { provider: { order: [...this.options.upstreams], allow_fallbacks: false, require_parameters: true } }
        : {}),
      ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
      ...(request.sampling?.seed !== undefined ? { seed: request.sampling.seed } : {}),
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
            tool_choice: "auto",
          }
        : {}),
      messages: request.messages.map((message) => {
        if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.content };
        if (message.role === "assistant")
          return {
            role: "assistant",
            content: message.content,
            ...(message.toolCalls?.length
              ? {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.callId,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                }
              : {}),
          };
        return { role: message.role, content: message.content };
      }),
    });
  }

  async *stream(request: ModelRequest, options: ModelCallOptions): AsyncGenerator<ModelStreamEvent> {
    const { requestId } = request;
    if (request.model !== this.options.model) throw new ModelGatewayError("unsupported", requestId);
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const fail = (): never => {
      if (options.signal?.aborted) throw new ModelGatewayError("aborted", requestId);
      if (deadline.aborted) throw new ModelGatewayError("timeout", requestId);
      throw new ModelGatewayError("provider_failure", requestId);
    };
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(this.options.referer ? { "http-referer": this.options.referer } : {}),
          ...(this.options.title ? { "x-title": this.options.title } : {}),
        },
        body: this.body(request),
      });
    } catch {
      fail();
    }
    if (!response!.ok || !response!.body) fail();
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let model: string | undefined;
    let finish: string | undefined;
    let usage: ModelUsage | undefined;
    let content = "";
    let receivedBytes = 0;
    let receivedFrames = 0;
    const calls = new Map<number, { callId: string; name?: string; arguments: string }>();
    try {
      while (!done) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          // Race the read against cancellation so a transport that ignores the abort signal cannot hang the caller.
          read = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolvePromise, rejectPromise) => {
            const onAbort = (): void => rejectPromise(new Error("aborted"));
            if (signal.aborted) return onAbort();
            signal.addEventListener("abort", onAbort, { once: true });
            reader
              .read()
              .then(resolvePromise, rejectPromise)
              .finally(() => signal.removeEventListener("abort", onAbort));
          });
        } catch {
          fail();
        }
        if (read!.done) break;
        receivedBytes += read!.value.byteLength;
        if (receivedBytes > 4_194_304) throw new ModelGatewayError("provider_failure", requestId);
        buffer += decoder.decode(read!.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (++receivedFrames > 16_384) throw new ModelGatewayError("provider_failure", requestId);
          if (payload === "[DONE]") {
            done = true;
            break;
          }
          let chunk: Chunk;
          try {
            chunk = JSON.parse(payload) as Chunk;
          } catch {
            throw new ModelGatewayError("provider_failure", requestId);
          }
          if (
            !chunk ||
            typeof chunk !== "object" ||
            Array.isArray(chunk) ||
            chunk.error ||
            (chunk.choices !== undefined && (!Array.isArray(chunk.choices) || chunk.choices.length > 1))
          )
            throw new ModelGatewayError("provider_failure", requestId);
          if (typeof chunk.model === "string" && chunk.model) {
            if (model && model !== chunk.model) throw new ModelGatewayError("provider_failure", requestId);
            model = chunk.model;
          }
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            content += choice.delta.content;
            yield { type: "text.delta", requestId, text: choice.delta.content };
          }
          for (const delta of choice?.delta?.tool_calls ?? []) {
            if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index >= 32)
              throw new ModelGatewayError("provider_failure", requestId);
            let call = calls.get(delta.index);
            if (!call) {
              if (!delta.id) throw new ModelGatewayError("provider_failure", requestId);
              call = { callId: delta.id, arguments: "" };
              calls.set(delta.index, call);
            } else if (delta.id && delta.id !== call.callId) throw new ModelGatewayError("provider_failure", requestId);
            const name = delta.function?.name;
            if (name) {
              if (call.name && call.name !== name) throw new ModelGatewayError("provider_failure", requestId);
              call.name = name;
            }
            const argumentsDelta = delta.function?.arguments ?? "";
            call.arguments += argumentsDelta;
            yield {
              type: "tool_call.delta",
              requestId,
              callId: call.callId,
              ...(name ? { name } : {}),
              argumentsDelta,
            };
          }
          if (choice?.finish_reason) {
            if (choice.finish_reason === "error") throw new ModelGatewayError("provider_failure", requestId);
            if (finish && finish !== choice.finish_reason) throw new ModelGatewayError("provider_failure", requestId);
            finish = choice.finish_reason;
          }
          if (chunk.usage && typeof chunk.usage === "object") {
            const { prompt_tokens, completion_tokens } = chunk.usage;
            if (
              !Number.isSafeInteger(prompt_tokens) ||
              !Number.isSafeInteger(completion_tokens) ||
              prompt_tokens! < 0 ||
              completion_tokens! < 0
            )
              throw new ModelGatewayError("provider_failure", requestId);
            usage = { inputTokens: prompt_tokens!, outputTokens: completion_tokens! };
            yield { type: "usage", requestId, usage };
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    if (signal.aborted) fail();
    // The provider terminates every stream with the [DONE] sentinel. EOF before it means the transport was cut, and a
    // response assembled from a truncated stream is never treated as final.
    if (!done || !finish || !model) throw new ModelGatewayError("incomplete_stream", requestId);
    if (!usage) throw new ModelGatewayError("provider_failure", requestId);
    const finishReason = finishReasons[finish];
    if (!finishReason) throw new ModelGatewayError("provider_failure", requestId);
    const truncated = finishReason === "length" || finishReason === "refusal";
    const toolCalls: ModelToolCall[] = [];
    if (!truncated) {
      for (const call of [...calls.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)) {
        if (!call.name) throw new ModelGatewayError("provider_failure", requestId);
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.arguments || "{}");
        } catch {
          throw new ModelGatewayError("provider_failure", requestId);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          throw new ModelGatewayError("provider_failure", requestId);
        toolCalls.push({ callId: call.callId, name: call.name, arguments: parsed as ModelToolCall["arguments"] });
      }
    }
    if (!truncated && (finishReason === "tool_calls") !== toolCalls.length > 0)
      throw new ModelGatewayError("provider_failure", requestId);
    yield {
      type: "completed",
      requestId,
      response: {
        requestId,
        model,
        content,
        toolCalls,
        finishReason,
        usage,
      },
    };
  }
}
