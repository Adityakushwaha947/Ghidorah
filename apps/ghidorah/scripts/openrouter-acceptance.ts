/**
 * Finite-budget live acceptance of the OpenRouter adapter through the model gateway and the Postgres dispatch
 * journal. Runs against the local fixture database only. Requires OPENROUTER_API_KEY in the process environment;
 * this script never reads a file for it and never prints it. Expected cost: well under one cent on z-ai/glm-4.7.
 *
 *   OPENROUTER_API_KEY=... GIDORAH_DATABASE_PROFILE=local GIDORAH_DATABASE_URL=... \
 *     node --import tsx scripts/openrouter-acceptance.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { SEAM_VERSION } from "@ghidorah/contracts";
import type { ModelRequest, ModelResponse } from "@ghidorah/contracts";
import { databaseConfig } from "../src/config.js";
import { FIXTURE_TARGET, fixtureConfig } from "@ghidorah/foundation";
import { ModelGateway } from "@ghidorah/model";
import { OpenRouterClient } from "@ghidorah/model";
import { PostgresJournal } from "../src/storage/journal.js";
import { PostgresModelDispatchJournal } from "../src/storage/model-dispatch-journal.js";

// GLM 4.7 is a reasoning model: hidden reasoning tokens count against max_tokens, so output budgets need headroom.
const MODEL = "z-ai/glm-4.7";
// Pinned upstream. OpenRouter otherwise load-balances across providers; one was observed returning 169 completion
// tokens against a 16-token cap, which the gateway correctly refused. DeepInfra honours max_tokens, seed and tools.
const UPSTREAMS = ["DeepInfra"];
// OpenRouter list price on 2026-09-19, USD per token. Used only to estimate the report's spend figure.
const PRICE = { input: 0.4 / 1e6, output: 1.75 / 1e6 };
const SPEND_CAP_USD = 0.25;

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set in the environment.");

const journal = new PostgresJournal(databaseConfig());
const runId = randomUUID();
await journal.createRun(runId, FIXTURE_TARGET, fixtureConfig({ capTokens: 60_000 }));
const lease = await journal.acquire(runId, 10_000);
const heartbeat = setInterval(() => void journal.heartbeat(lease).catch(() => undefined), 3000);

let httpCalls = 0;
const counting: typeof fetch = (input, init) => {
  httpCalls += 1;
  return fetch(input, init);
};
const client = new OpenRouterClient({
  apiKey,
  model: MODEL,
  fetch: counting,
  upstreams: UPSTREAMS,
  referer: "https://github.com/Adityakushwaha947/Ghidorah",
  title: "Ghidorah acceptance",
});
const dispatches = new PostgresModelDispatchJournal(journal, lease);
const gateway = new ModelGateway(
  [
    {
      id: `openrouter:${MODEL}`,
      provider: "openrouter",
      model: MODEL,
      responseModels: [MODEL],
      client,
      sampling: ["temperature", "seed"],
    },
  ],
  [
    {
      name: "fixture_read",
      description: "Read the isolated synthetic fixture counter by key. Has no effect on any real system.",
      schema: z.strictObject({ key: z.string().min(1) }),
    },
  ],
  dispatches,
);

type Step = {
  name: string;
  requestId: string;
  outcome: string;
  finishReason?: string;
  usage?: ModelResponse["usage"];
  toolCalls?: number;
  detail?: string;
};
const steps: Step[] = [];
let spentInput = 0;
let spentOutput = 0;
const spentUsd = () => spentInput * PRICE.input + spentOutput * PRICE.output;

function request(
  requestId: string,
  messages: ModelRequest["messages"],
  tools: ModelRequest["tools"],
  maxOutputTokens: number,
): ModelRequest {
  return {
    seamVersion: SEAM_VERSION.model,
    requestId,
    model: MODEL,
    messages,
    tools,
    maxOutputTokens,
    sampling: { temperature: 0, seed: 7 },
  };
}

async function run(name: string, input: ModelRequest, timeoutMs: number): Promise<ModelResponse | undefined> {
  if (spentUsd() > SPEND_CAP_USD) throw new Error("Spend cap reached; refusing further live calls.");
  try {
    const response = await gateway.complete(input, { timeoutMs });
    spentInput += response.usage.inputTokens;
    spentOutput += response.usage.outputTokens;
    steps.push({
      name,
      requestId: input.requestId,
      outcome: "completed",
      finishReason: response.finishReason,
      usage: response.usage,
      toolCalls: response.toolCalls.length,
    });
    return response;
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown";
    const status = await dispatches.status(input.requestId);
    steps.push({
      name,
      requestId: input.requestId,
      outcome: `error:${code}`,
      detail: status ? `journal ${status.state}, finalUsageKnown=${status.finalUsageKnown}` : "no reservation",
    });
    return undefined;
  }
}

try {
  const text = await run(
    "text-only",
    request(
      "acc-text",
      [
        { role: "system", content: "Reply with exactly one word and nothing else." },
        { role: "user", content: "Say the word: ready" },
      ],
      [],
      256,
    ),
    60_000,
  );
  const callsBeforeTool = httpCalls;
  const tool = await run(
    "tool-call",
    request(
      "acc-tool",
      [
        {
          role: "system",
          content:
            'You are a test harness. You must call the fixture_read tool with key "counter". Do not answer in text.',
        },
        { role: "user", content: "Read the counter." },
      ],
      gateway.describeTools(),
      512,
    ),
    90_000,
  );
  const callsAfterTool = httpCalls;
  const replay = await run(
    "replay-same-id",
    request(
      "acc-tool",
      [
        {
          role: "system",
          content:
            'You are a test harness. You must call the fixture_read tool with key "counter". Do not answer in text.',
        },
        { role: "user", content: "Read the counter." },
      ],
      gateway.describeTools(),
      512,
    ),
    90_000,
  );
  const replayDispatched = httpCalls !== callsAfterTool;
  await run("timeout-1ms", request("acc-timeout", [{ role: "user", content: "Count to fifty slowly." }], [], 64), 1);
  const blocked = await run(
    "after-unresolved",
    request("acc-after", [{ role: "user", content: "hi" }], [], 64),
    30_000,
  );
  const runRecord = await journal.read(runId);
  const report = {
    checkedOn: new Date().toISOString(),
    runId,
    model: MODEL,
    upstreams: UPSTREAMS,
    seam: SEAM_VERSION.model,
    httpCalls,
    steps,
    assertions: {
      textCompleted: text?.finishReason === "stop" && !!text.content.trim(),
      toolCallFinalized:
        tool?.finishReason === "tool_calls" &&
        tool.toolCalls[0]?.name === "fixture_read" &&
        tool.toolCalls[0]?.arguments.key === "counter",
      toolCallUsedOneHttpRequest: callsAfterTool - callsBeforeTool === 1,
      replayServedFromJournal: !!replay && !replayDispatched && JSON.stringify(replay) === JSON.stringify(tool),
      timeoutRecordedAsUnresolved: steps.find((step) => step.name === "timeout-1ms")?.outcome === "error:timeout",
      newDispatchBlockedAfterUnresolved: blocked === undefined && steps.at(-1)?.outcome === "error:unavailable",
    },
    runBudget: {
      capTokens: runRecord.config.capTokens,
      spentTokens: runRecord.spent.tokens,
      spentSteps: runRecord.spent.steps,
    },
    estimatedSpendUsd: Number(spentUsd().toFixed(6)),
    spendCapUsd: SPEND_CAP_USD,
    limits: [
      "Live transport proof for one pinned route only; not a claim about other models or providers.",
      "Estimated spend uses list pricing captured in this script, not a billing statement.",
      "Cancellation proves the gateway stopped waiting; the provider may still have billed the aborted request.",
      "The unresolved timeout dispatch is left unreconciled on purpose to show the block; reconcile it out of band.",
    ],
  };
  const accepted = Object.values(report.assertions).every(Boolean);
  await mkdir(resolve("tmp"), { recursive: true });
  const destination = resolve("tmp", `openrouter-acceptance-${report.checkedOn.replaceAll(":", "-")}.json`);
  await writeFile(destination, `${JSON.stringify({ accepted, ...report }, null, 2)}\n`);
  console.log(JSON.stringify({ accepted, ...report }, null, 2));
  console.error(`Report: ${destination}`);
  process.exitCode = accepted ? 0 : 1;
} finally {
  clearInterval(heartbeat);
  await journal.finish(lease, "stopped").catch(() => undefined);
  await journal.release(lease).catch(() => undefined);
  await journal.close();
}
