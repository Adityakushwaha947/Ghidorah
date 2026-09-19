import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from "@ai-sdk/provider-v5";
import { z } from "zod";
import { digest } from "../foundation/digest.js";
import { GidorahError } from "../foundation/errors.js";
import { FIXTURE_MODEL, RUNTIME_VERSION } from "../foundation/fixture-contract.js";
import type { FixtureHooks } from "../execution/fixture-executor.js";
import type { Lease, PostgresJournal } from "../storage/journal.js";

const responseSchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  tool_calls: z
    .array(
      z.strictObject({
        id: z.string(),
        name: z.enum(["fixture_increment", "fixture_read"]),
        args: z.strictObject({}),
        type: z.literal("tool_call"),
      }),
    )
    .max(1),
  usage_metadata: z.strictObject({
    input_tokens: z.literal(1),
    output_tokens: z.literal(1),
    total_tokens: z.literal(2),
  }),
});

export type BoundaryGuard = <Result>(operation: () => Promise<Result>) => Promise<Result>;

export class JournaledFixtureModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "mettle-synthetic";
  readonly modelId = FIXTURE_MODEL;
  readonly supportedUrls = {};

  constructor(
    private readonly journal: PostgresJournal,
    private readonly lease: Lease,
    private readonly guard: BoundaryGuard,
    private readonly hooks: FixtureHooks = {},
  ) {}

  private response(options: LanguageModelV2CallOptions) {
    return this.guard(async () => {
      if (options.abortSignal?.aborted) throw new GidorahError("stop_requested", "Model admission was cancelled.");
      const ordinal = options.prompt.filter((message) => message.role === "assistant").length;
      const key = `model-${ordinal}`;
      const request = { runtime: RUNTIME_VERSION, messages: JSON.parse(JSON.stringify(options.prompt)) };
      const cached = await this.journal.beginModel(this.lease, key, request);
      const nextTool = ordinal === 0 ? "fixture_increment" : ordinal === 1 ? "fixture_read" : undefined;
      const response = responseSchema.parse(
        cached ?? {
          id: `model-${digest({ runId: this.lease.runId, key })}`,
          content: nextTool
            ? "Executing the registered synthetic fixture."
            : "Synthetic fixture completed. No security assessment or vulnerability verification was performed.",
          tool_calls: nextTool
            ? [
                {
                  id: `call-${digest({ runId: this.lease.runId, key, ordinal: 0 })}`,
                  name: nextTool,
                  args: {},
                  type: "tool_call",
                },
              ]
            : [],
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      );
      if (cached === undefined) {
        await this.journal.completeModel(this.lease, key, response);
        await this.hooks.at?.("after-model");
      }
      return response;
    });
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const response = await this.response(options);
    return {
      content: response.tool_calls.length
        ? response.tool_calls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            input: JSON.stringify(call.args),
          }))
        : [{ type: "text", text: response.content }],
      finishReason: response.tool_calls.length ? "tool-calls" : "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
      response: { id: response.id },
    };
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const response = await this.response(options);
    return {
      stream: new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "response-metadata", id: response.id });
          for (const call of response.tool_calls)
            controller.enqueue({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.name,
              input: JSON.stringify(call.args),
            });
          if (!response.tool_calls.length) {
            controller.enqueue({ type: "text-start", id: response.id });
            controller.enqueue({ type: "text-delta", id: response.id, delta: response.content });
            controller.enqueue({ type: "text-end", id: response.id });
          }
          controller.enqueue({
            type: "finish",
            finishReason: response.tool_calls.length ? "tool-calls" : "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    };
  }
}
