import { z } from "zod";
import { PositiveIntegerSchema, SEAM_VERSION } from "@ghidorah/contracts";
import {
  ModelRequestSchema,
  ModelResponseSchema,
  ModelStreamEventSchema,
  type JsonValue,
  type ModelCallOptions,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
  type ModelUsage,
} from "@ghidorah/contracts";
import { canonicalJson, sha256 } from "@ghidorah/foundation";
import { ModelGatewayError } from "./errors.js";

export type ModelRoute = {
  id: string;
  provider: string;
  model: string;
  responseModels: readonly string[];
  client: ModelClient;
  sampling: readonly ("temperature" | "seed")[];
};
export type GatewayTool = { name: string; description: string; schema: z.ZodType };
export type DispatchRecord = {
  requestId: string;
  routeId: string;
  provider: string;
  requestedModel: string;
  canonicalRequest: string;
  requestDigest: string;
};
export interface ModelDispatchJournal {
  reserve(
    record: DispatchRecord,
    request: ModelRequest,
  ): Promise<{ state: "reserved"; tokens: number } | { state: "completed"; response: unknown }>;
  recordUsage(requestId: string, cumulative: ModelUsage): Promise<void>;
  complete(requestId: string, response: ModelResponse): Promise<void>;
  fail(
    requestId: string,
    failure: { code: ModelGatewayError["code"]; observedUsage: ModelUsage | null; finalUsageKnown: false },
  ): Promise<void>;
}
type Limits = { requestBytes: number; streamBytes: number; events: number; toolCalls: number };
const defaults: Limits = { requestBytes: 1_048_576, streamBytes: 4_194_304, events: 16_384, toolCalls: 32 };

function abortable<Value>(operation: Promise<Value>, signal: AbortSignal, requestId: string): Promise<Value> {
  return new Promise((resolve, reject) => {
    const cancelled = (): void =>
      reject(signal.reason instanceof ModelGatewayError ? signal.reason : new ModelGatewayError("aborted", requestId));
    signal.addEventListener("abort", cancelled, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled));
    if (signal.aborted) cancelled();
  });
}

export class ModelGateway implements ModelClient {
  readonly seamVersion = SEAM_VERSION.model;
  private readonly routes = new Map<string, ModelRoute>();
  private readonly tools = new Map<string, GatewayTool & { inputSchema: { [key: string]: JsonValue } }>();
  private readonly limits: Limits;
  private busy = false;

  constructor(
    routes: readonly ModelRoute[],
    tools: readonly GatewayTool[],
    private readonly journal: ModelDispatchJournal,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
    for (const limit of Object.values(this.limits)) PositiveIntegerSchema.parse(limit);
    for (const route of routes) {
      if (
        !route.id ||
        !route.provider ||
        !route.model ||
        this.routes.has(route.model) ||
        !route.responseModels.length ||
        route.responseModels.some((model) => !model) ||
        route.client.seamVersion !== SEAM_VERSION.model ||
        route.sampling.some((parameter) => !["temperature", "seed"].includes(parameter))
      )
        throw new ModelGatewayError("unsupported", "configuration");
      this.routes.set(route.model, {
        ...route,
        responseModels: [...route.responseModels],
        sampling: [...route.sampling],
      });
    }
    for (const tool of tools) {
      if (!tool.name || this.tools.has(tool.name)) throw new ModelGatewayError("unsupported", "configuration");
      const inputSchema = z.toJSONSchema(tool.schema) as { [key: string]: JsonValue };
      if (inputSchema.type !== "object") throw new ModelGatewayError("unsupported", "configuration");
      this.tools.set(tool.name, { ...tool, inputSchema });
    }
  }

  describeTools(): ModelRequest["tools"] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: structuredClone(inputSchema),
    }));
  }

  private prepare(
    input: ModelRequest,
    options: ModelCallOptions,
  ): { request: ModelRequest; route: ModelRoute; canonical: string } {
    const requestId = typeof input?.requestId === "string" && input.requestId ? input.requestId : "invalid-request";
    if (input?.seamVersion !== SEAM_VERSION.model) throw new ModelGatewayError("version_mismatch", requestId);
    let request: ModelRequest;
    let canonical: string;
    try {
      PositiveIntegerSchema.parse(options.timeoutMs);
      if (
        Object.keys(options).some((key) => key !== "timeoutMs" && key !== "signal") ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      )
        throw new Error();
      canonical = canonicalJson(input);
      if (Buffer.byteLength(canonical) > this.limits.requestBytes) throw new Error();
      request = ModelRequestSchema.parse(JSON.parse(canonical));
    } catch {
      throw new ModelGatewayError("invalid_request", requestId);
    }
    const route = this.routes.get(request.model);
    if (
      !route ||
      route.client.seamVersion !== SEAM_VERSION.model ||
      Object.keys(request.sampling ?? {}).some((key) => !route.sampling.includes(key as "temperature" | "seed"))
    )
      throw new ModelGatewayError("unsupported", requestId);
    for (const tool of request.tools) {
      const registered = this.tools.get(tool.name);
      if (
        !registered ||
        registered.description !== tool.description ||
        canonicalJson(registered.inputSchema) !== canonicalJson(tool.inputSchema)
      )
        throw new ModelGatewayError("unsupported", requestId);
    }
    for (const message of request.messages)
      if (message.role === "assistant") this.validateCalls(request, message.toolCalls ?? [], "invalid_request");
    return { request, route, canonical };
  }

  private validateCalls(
    request: ModelRequest,
    calls: ModelToolCall[],
    code: "invalid_request" | "provider_failure",
  ): void {
    if (calls.length > this.limits.toolCalls) throw new ModelGatewayError(code, request.requestId);
    for (const call of calls) {
      const tool = this.tools.get(call.name);
      if (!tool || !request.tools.some((entry) => entry.name === call.name))
        throw new ModelGatewayError(code, request.requestId);
      const result = tool.schema.safeParse(call.arguments);
      if (!result.success || canonicalJson(result.data) !== canonicalJson(call.arguments))
        throw new ModelGatewayError(code, request.requestId);
    }
  }

  private validateResponse(request: ModelRequest, route: ModelRoute, input: unknown): ModelResponse {
    try {
      if (Buffer.byteLength(canonicalJson(input)) > this.limits.streamBytes) throw new Error();
      const response = ModelResponseSchema.parse(input);
      if (
        response.requestId !== request.requestId ||
        !route.responseModels.includes(response.model) ||
        response.usage.outputTokens > request.maxOutputTokens
      )
        throw new Error();
      this.validateCalls(request, response.toolCalls, "provider_failure");
      const previousIds = new Set(
        request.messages.flatMap((message) =>
          message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.callId) : [],
        ),
      );
      if (response.toolCalls.some((call) => previousIds.has(call.callId))) throw new Error();
      return response;
    } catch {
      throw new ModelGatewayError("provider_failure", request.requestId);
    }
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse> {
    for await (const event of this.stream(request, options)) if (event.type === "completed") return event.response;
    throw new ModelGatewayError("incomplete_stream", request.requestId);
  }

  async *stream(input: ModelRequest, options: ModelCallOptions): AsyncGenerator<ModelStreamEvent> {
    const { request, route, canonical } = this.prepare(input, options);
    if (options.signal?.aborted) throw new ModelGatewayError("aborted", request.requestId);
    if (this.busy) throw new ModelGatewayError("unavailable", request.requestId);
    this.busy = true;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let reserved = false;
    let settled = false;
    let observedUsage: ModelUsage | null = null;
    let iterator: AsyncIterator<ModelStreamEvent> | undefined;
    const storage = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
      try {
        return await operation();
      } catch {
        throw new ModelGatewayError("unavailable", request.requestId);
      }
    };
    try {
      const reservation = await storage(() =>
        this.journal.reserve(
          {
            requestId: request.requestId,
            routeId: route.id,
            provider: route.provider,
            requestedModel: request.model,
            canonicalRequest: canonical,
            requestDigest: sha256(canonical),
          },
          structuredClone(request),
        ),
      );
      if (!reservation || !["reserved", "completed"].includes(reservation.state))
        throw new ModelGatewayError("unavailable", request.requestId);
      reserved = reservation.state === "reserved";
      if (signal.aborted) throw signal.reason;
      if (reservation.state === "completed") {
        const response = this.validateResponse(request, route, reservation.response);
        settled = true;
        yield { type: "completed", requestId: request.requestId, response };
        return;
      }
      const checkedReservation = PositiveIntegerSchema.safeParse(reservation.tokens);
      if (!checkedReservation.success || checkedReservation.data < request.maxOutputTokens)
        throw new ModelGatewayError("unavailable", request.requestId);
      const reservedTokens = checkedReservation.data;
      if (signal.aborted) throw signal.reason;
      const recordUsage = async (usage: ModelUsage): Promise<void> => {
        if (
          observedUsage &&
          (usage.inputTokens < observedUsage.inputTokens || usage.outputTokens < observedUsage.outputTokens)
        )
          throw new ModelGatewayError("provider_failure", request.requestId);
        if (
          !observedUsage ||
          usage.inputTokens !== observedUsage.inputTokens ||
          usage.outputTokens !== observedUsage.outputTokens
        ) {
          observedUsage = { ...usage };
          await storage(() => this.journal.recordUsage(request.requestId, { ...usage }));
        }
        if (usage.inputTokens + usage.outputTokens > reservedTokens || usage.outputTokens > request.maxOutputTokens)
          throw new ModelGatewayError("provider_failure", request.requestId);
      };
      iterator = route.client
        .stream(structuredClone(request), { timeoutMs: options.timeoutMs, signal })
        [Symbol.asyncIterator]();
      let completed: ModelResponse | undefined;
      let streamBytes = 0;
      let eventCount = 0;
      let text = "";
      let sawText = false;
      const calls = new Map<string, { name?: string; arguments: string }>();
      while (true) {
        const next = await abortable(iterator.next(), signal, request.requestId);
        if (next.done) break;
        if (completed) throw new ModelGatewayError("provider_failure", request.requestId);
        streamBytes += Buffer.byteLength(canonicalJson(next.value));
        if (++eventCount > this.limits.events || streamBytes > this.limits.streamBytes)
          throw new ModelGatewayError("provider_failure", request.requestId);
        const event = ModelStreamEventSchema.parse(next.value);
        if (event.requestId !== request.requestId) throw new ModelGatewayError("provider_failure", request.requestId);
        if (event.type === "text.delta") {
          sawText = true;
          text += event.text;
        }
        if (event.type === "tool_call.delta") {
          const call = calls.get(event.callId) ?? { arguments: "" };
          if (call.name && event.name && call.name !== event.name)
            throw new ModelGatewayError("provider_failure", request.requestId);
          if (event.name) call.name = event.name;
          call.arguments += event.argumentsDelta;
          calls.set(event.callId, call);
          if (calls.size > this.limits.toolCalls) throw new ModelGatewayError("provider_failure", request.requestId);
        }
        if (event.type === "usage") await recordUsage(event.usage);
        if (event.type === "completed") {
          await recordUsage(event.response.usage);
          completed = this.validateResponse(request, route, event.response);
          if (sawText && text !== completed.content) throw new ModelGatewayError("provider_failure", request.requestId);
          if (calls.size && !["length", "refusal"].includes(completed.finishReason)) {
            if (calls.size !== completed.toolCalls.length)
              throw new ModelGatewayError("provider_failure", request.requestId);
            for (const call of completed.toolCalls) {
              const partial = calls.get(call.callId);
              if (
                !partial ||
                partial.name !== call.name ||
                canonicalJson(JSON.parse(partial.arguments)) !== canonicalJson(call.arguments)
              )
                throw new ModelGatewayError("provider_failure", request.requestId);
            }
          }
        } else yield event;
      }
      if (!completed) throw new ModelGatewayError("incomplete_stream", request.requestId);
      if (signal.aborted) throw signal.reason;
      await storage(() => this.journal.complete(request.requestId, structuredClone(completed!)));
      settled = true;
      if (signal.aborted) throw signal.reason;
      yield { type: "completed", requestId: request.requestId, response: completed };
    } catch (error) {
      const failure = new ModelGatewayError(
        signal.aborted
          ? timedOut
            ? "timeout"
            : "aborted"
          : error instanceof ModelGatewayError
            ? error.code
            : "provider_failure",
        request.requestId,
      );
      controller.abort(failure);
      if (reserved && !settled) {
        settled = true;
        await storage(() =>
          this.journal.fail(request.requestId, { code: failure.code, observedUsage, finalUsageKnown: false }),
        );
      }
      throw failure;
    } finally {
      controller.abort();
      clearTimeout(timeout);
      try {
        if (reserved && !settled)
          await storage(() =>
            this.journal.fail(request.requestId, { code: "aborted", observedUsage, finalUsageKnown: false }),
          );
      } finally {
        this.busy = false;
        if (iterator?.return) void iterator.return().catch(() => undefined);
      }
    }
  }
}
