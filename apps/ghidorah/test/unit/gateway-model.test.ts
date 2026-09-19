import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV2CallOptions } from "@ai-sdk/provider-v5";
import { ModelGateway } from "@ghidorah/model";
import { FIXTURE_TARGET, fixtureConfig } from "@ghidorah/foundation";
import { gatewayRequest } from "../../src/runtime/gateway-model.js";
import { counterModelProfile, validateCounterRun } from "../../src/runtime/model-profile.js";
import { counterTools } from "../../src/tools/counter.js";
import { modelCounter } from "../helpers/model-counter.js";

const { profile } = modelCounter();
const gateway = new ModelGateway([profile.route], counterTools, {
  reserve: async () => {
    throw new Error("No unit test may dispatch.");
  },
  recordUsage: async () => {},
  complete: async () => {},
  fail: async () => {},
});

function options(overrides: Partial<LanguageModelV2CallOptions> = {}): LanguageModelV2CallOptions {
  return {
    prompt: [
      { role: "system", content: "Counter only." },
      { role: "user", content: [{ type: "text", text: "Run." }] },
    ],
    tools: gateway.describeTools().map((tool) => ({ type: "function", ...tool })),
    ...overrides,
  };
}

test("model profile admits only the pinned model on the existing counter scope", () => {
  const config = fixtureConfig({ model: profile.route.model });
  assert.equal(validateCounterRun(FIXTURE_TARGET, config, profile).model, "test/counter");
  assert.throws(() => validateCounterRun("https://customer.invalid", config, profile));
  assert.throws(() => validateCounterRun(FIXTURE_TARGET, config));
  assert.throws(() => validateCounterRun(FIXTURE_TARGET, { ...config, capUsd: 0 }, profile));
  assert.throws(() => validateCounterRun(FIXTURE_TARGET, { ...config, approvalProfile: "live-target" }, profile));
});

test("route and accounting-policy changes create incompatible recovery identities", () => {
  assert.equal(counterModelProfile(profile).runtimeVersion, profile.runtimeVersion);
  assert.notEqual(
    counterModelProfile({ ...profile, inputBoundRevision: "changed" }).runtimeVersion,
    profile.runtimeVersion,
  );
  assert.notEqual(
    counterModelProfile({ ...profile, route: { ...profile.route, id: "other-route" } }).runtimeVersion,
    profile.runtimeVersion,
  );
});

test("Mastra text and tool history normalize to the shared model seam", () => {
  const request = gatewayRequest(
    "run",
    profile,
    gateway,
    options({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Run." }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call", toolName: "fixture_read", input: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "fixture_read",
              output: { type: "json", value: { counter: 1 } },
            },
          ],
        },
      ],
    }),
  );
  assert.equal(request.requestId, "run:model-1");
  assert.deepEqual(request.messages.at(-1), { role: "tool", callId: "call", content: '{"counter":1}', isError: false });
  assert.deepEqual(request.tools, gateway.describeTools());
});

test("tool schemas and descriptions cannot be substituted by the runtime caller", () => {
  const tools = options().tools!;
  assert.throws(() =>
    gatewayRequest(
      "run",
      profile,
      gateway,
      options({ tools: [{ ...tools[0]!, description: "changed" } as (typeof tools)[number]] }),
    ),
  );
  assert.throws(() =>
    gatewayRequest("run", profile, gateway, options({ tools: [{ type: "function", name: "shell", inputSchema: {} }] })),
  );
});

test("provider side channels, forced tools and unmetered inputs fail before dispatch", () => {
  for (const override of [
    { providerOptions: { vendor: { route: "hidden" } } },
    { headers: { authorization: "hidden" } },
    { toolChoice: { type: "required" } },
    { responseFormat: { type: "json" } },
    { topP: 0.8 },
    { maxOutputTokens: 65 },
  ] as Partial<LanguageModelV2CallOptions>[])
    assert.throws(() => gatewayRequest("run", profile, gateway, options(override)));
});

test("unregistered media, reasoning and mismatched result names are rejected", () => {
  const prompts: LanguageModelV2CallOptions["prompt"][] = [
    [{ role: "assistant", content: [{ type: "reasoning", text: "private" }] }],
    [
      {
        role: "user",
        content: [{ type: "file", mediaType: "text/plain", data: new URL("https://unapproved.invalid/file") }],
      },
    ],
    [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "fixture_read", input: {} }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "fixture_increment",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ],
  ];
  for (const prompt of prompts) assert.throws(() => gatewayRequest("run", profile, gateway, options({ prompt })));
});
