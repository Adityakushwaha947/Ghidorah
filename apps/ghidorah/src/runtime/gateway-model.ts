import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider-v5";
import {
  JsonObjectSchema,
  ModelRequestSchema,
  SEAM_VERSION,
  type ModelRequest,
  type ModelResponse,
} from "@ghidorah/contracts";
import { canonicalJson, GidorahError } from "@ghidorah/foundation";
import type { ModelGateway } from "@ghidorah/model";
import type { BoundaryGuard } from "./fixture-model.js";
import type { CounterModelProfile } from "./model-profile.js";

function unsupported(reason: string): never {
  throw new GidorahError(
    "unsupported_model_input",
    `The model boundary accepts only registered text and tool messages (${reason}).`,
  );
}

/**
 * Mastra stamps `providerOptions.mastra` (for example `createdAt`) on messages and parts. That namespace is runtime
 * bookkeeping, never part of the canonical request, so it is ignored. Any other provider namespace is refused: the
 * gateway must not forward provider-specific instructions it has not registered.
 */
function hasOptions(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return Object.keys(value as object).some((key) => key !== "mastra");
}

function comparableSchema(value: object): string {
  const { $schema: _schema, ...rest } = value as Record<string, unknown>;
  return canonicalJson(rest);
}

export function gatewayRequest(
  runId: string,
  profile: CounterModelProfile,
  gateway: Pick<ModelGateway, "describeTools">,
  options: LanguageModelV2CallOptions,
): ModelRequest {
  if (hasOptions(options.headers)) unsupported("headers");
  if (hasOptions(options.providerOptions)) unsupported("providerOptions");
  if (options.includeRawChunks) unsupported("includeRawChunks");
  if (options.responseFormat?.type === "json") unsupported("responseFormat");
  if (options.topP !== undefined || options.topK !== undefined) unsupported("topP/topK");
  if (options.presencePenalty !== undefined || options.frequencyPenalty !== undefined) unsupported("penalties");
  if (options.stopSequences?.length) unsupported("stopSequences");
  if (options.toolChoice && !["auto", "none"].includes(options.toolChoice.type)) unsupported("toolChoice");
  const maxOutputTokens = options.maxOutputTokens ?? profile.maxOutputTokens;
  if (maxOutputTokens > profile.maxOutputTokens) unsupported("maxOutputTokens above profile");
  const registered = gateway.describeTools();
  const requested = options.tools ?? [];
  const tools = requested.map((tool) => {
    if (tool.type !== "function" || hasOptions(tool.providerOptions)) return unsupported(`tool ${tool.name}`);
    const known = registered.find((entry) => entry.name === tool.name);
    if (!known) return unsupported(`unregistered tool ${tool.name}`);
    if (known.description !== tool.description) return unsupported(`tool description ${tool.name}`);
    if (comparableSchema(known.inputSchema) !== comparableSchema(tool.inputSchema))
      return unsupported(
        `tool schema ${tool.name}: ${comparableSchema(tool.inputSchema)} vs ${comparableSchema(known.inputSchema)}`,
      );
    return known;
  });
  const messages: ModelRequest["messages"] = [];
  const callNames = new Map<string, string>();
  for (const message of options.prompt) {
    if (hasOptions(message.providerOptions)) unsupported(`${message.role} providerOptions`);
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (hasOptions(part.providerOptions)) unsupported("tool result providerOptions");
        if (callNames.get(part.toolCallId) !== part.toolName) unsupported("tool result without matching call");
        const output = part.output;
        if (output.type === "content") unsupported("tool result content parts");
        messages.push({
          role: "tool",
          callId: part.toolCallId,
          content: output.type === "text" || output.type === "error-text" ? output.value : canonicalJson(output.value),
          isError: output.type === "error-text" || output.type === "error-json",
        });
      }
      continue;
    }
    let content = "";
    const toolCalls: ModelResponse["toolCalls"] = [];
    for (const part of message.content) {
      if (hasOptions(part.providerOptions)) unsupported(`${message.role} part providerOptions`);
      if (part.type === "text") content += part.text;
      else if (message.role === "assistant" && part.type === "tool-call" && !part.providerExecuted) {
        const call = { callId: part.toolCallId, name: part.toolName, arguments: JsonObjectSchema.parse(part.input) };
        toolCalls.push(call);
        callNames.set(call.callId, call.name);
      } else unsupported(`${message.role} part ${part.type}`);
    }
    messages.push(message.role === "assistant" ? { role: "assistant", content, toolCalls } : { role: "user", content });
  }
  const ordinal = options.prompt.filter((message) => message.role === "assistant").length;
  return ModelRequestSchema.parse({
    seamVersion: SEAM_VERSION.model,
    requestId: `${runId}:model-${ordinal}`,
    model: profile.route.model,
    messages,
    tools: options.toolChoice?.type === "none" ? [] : tools,
    maxOutputTokens,
    sampling: {
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    },
  });
}

export class GatewayLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly supportedUrls = {};
  readonly provider: string;
  readonly modelId: string;

  constructor(
    private readonly runId: string,
    private readonly profile: CounterModelProfile,
    private readonly gateway: ModelGateway,
    private readonly guard: BoundaryGuard,
    private readonly afterModel?: () => Promise<void>,
  ) {
    this.provider = profile.route.provider;
    this.modelId = profile.route.model;
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    return this.guard(async () => {
      const request = gatewayRequest(this.runId, this.profile, this.gateway, options);
      const response = await this.gateway.complete(request, {
        timeoutMs: this.profile.timeoutMs,
        signal: options.abortSignal,
      });
      await this.afterModel?.();
      const content: LanguageModelV2Content[] = [];
      if (response.content) content.push({ type: "text", text: response.content });
      for (const call of response.toolCalls)
        content.push({
          type: "tool-call",
          toolCallId: call.callId,
          toolName: call.name,
          input: canonicalJson(call.arguments),
        });
      return {
        content,
        finishReason:
          response.finishReason === "tool_calls"
            ? "tool-calls"
            : response.finishReason === "refusal"
              ? "content-filter"
              : response.finishReason,
        usage: { ...response.usage, totalTokens: response.usage.inputTokens + response.usage.outputTokens },
        warnings: [],
        response: { id: response.requestId, modelId: response.model },
      };
    });
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const result = await this.doGenerate(options);
    const responseId = result.response!.id!;
    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: result.warnings });
          controller.enqueue({ type: "response-metadata", ...result.response });
          for (const part of result.content) {
            if (part.type === "tool-call") controller.enqueue(part);
            else if (part.type === "text") {
              controller.enqueue({ type: "text-start", id: responseId });
              controller.enqueue({ type: "text-delta", id: responseId, delta: part.text });
              controller.enqueue({ type: "text-end", id: responseId });
            }
          }
          controller.enqueue({ type: "finish", finishReason: result.finishReason, usage: result.usage });
          controller.close();
        },
      }),
    };
  }
}
