import { z } from "zod";
import { IdentifierSchema as text, PositiveIntegerSchema, SEAM_VERSION } from "./common.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export const ModelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export const ModelToolCallSchema = z.strictObject({ callId: text, name: text, arguments: JsonObjectSchema });
export const ModelMessageSchema = z.union([
  z.strictObject({ role: z.enum(["system", "user"]), content: z.string() }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(ModelToolCallSchema).optional(),
  }),
  z.strictObject({ role: z.literal("tool"), callId: text, content: z.string(), isError: z.boolean() }),
]);
export const ModelToolSchema = z.strictObject({ name: text, description: z.string(), inputSchema: JsonObjectSchema });
export const ModelRequestSchema = z
  .strictObject({
    seamVersion: z.literal(SEAM_VERSION.model),
    requestId: text,
    model: text,
    messages: z.array(ModelMessageSchema).min(1),
    tools: z.array(ModelToolSchema),
    maxOutputTokens: PositiveIntegerSchema,
    sampling: z
      .strictObject({ temperature: z.number().finite().optional(), seed: z.number().int().optional() })
      .optional(),
  })
  .superRefine((request, context) => {
    const reject = (message: string): void => {
      context.addIssue({ code: "custom", message });
    };
    const names = new Set(request.tools.map((tool) => tool.name));
    if (names.size !== request.tools.length) reject("Tool names must be unique.");
    const seen = new Set<string>();
    const pending = new Set<string>();
    for (const message of request.messages) {
      if (message.role !== "tool" && pending.size)
        reject("Tool results must resolve preceding calls before another message.");
      if (message.role === "assistant") {
        for (const call of message.toolCalls ?? []) {
          if (seen.has(call.callId) || !names.has(call.name)) reject("Duplicate call identity or unregistered tool.");
          seen.add(call.callId);
          pending.add(call.callId);
        }
      } else if (message.role === "tool" && !pending.delete(message.callId))
        reject("Tool result has no unique preceding call.");
    }
    if (pending.size) reject("Unresolved tool calls cannot be submitted for inference.");
  });
export const ModelResponseSchema = z
  .strictObject({
    requestId: text,
    model: text,
    content: z.string(),
    toolCalls: z.array(ModelToolCallSchema),
    finishReason: z.enum(["stop", "tool_calls", "length", "refusal"]),
    usage: ModelUsageSchema,
  })
  .superRefine((response, context) => {
    if (new Set(response.toolCalls.map((call) => call.callId)).size !== response.toolCalls.length)
      context.addIssue({ code: "custom", message: "Tool-call identities must be unique." });
    if ((response.finishReason === "tool_calls") !== response.toolCalls.length > 0)
      context.addIssue({ code: "custom", message: "Only a finalized tool-call response may expose executable calls." });
  });
export const ModelStreamEventSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text.delta"), requestId: text, text: z.string() }),
    z.strictObject({
      type: z.literal("tool_call.delta"),
      requestId: text,
      callId: text,
      name: text.optional(),
      argumentsDelta: z.string(),
    }),
    z.strictObject({ type: z.literal("usage"), requestId: text, usage: ModelUsageSchema }),
    z.strictObject({ type: z.literal("completed"), requestId: text, response: ModelResponseSchema }),
  ])
  .superRefine((event, context) => {
    if (event.type === "completed" && event.response.requestId !== event.requestId)
      context.addIssue({ code: "custom", message: "Completed response identity differs from its envelope." });
  });
export const ModelErrorSchema = z.strictObject({
  code: z.enum([
    "version_mismatch",
    "invalid_request",
    "unsupported",
    "timeout",
    "aborted",
    "provider_failure",
    "unavailable",
    "incomplete_stream",
  ]),
  requestId: text,
  message: z.string(),
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export type ModelToolCall = z.infer<typeof ModelToolCallSchema>;
export type ModelStreamEvent = z.infer<typeof ModelStreamEventSchema>;
export type ModelError = z.infer<typeof ModelErrorSchema>;
export type ModelCallOptions = { timeoutMs: number; signal?: AbortSignal };
export interface ModelClient {
  readonly seamVersion: typeof SEAM_VERSION.model;
  complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResponse>;
  stream(request: ModelRequest, options: ModelCallOptions): AsyncIterable<ModelStreamEvent>;
}
