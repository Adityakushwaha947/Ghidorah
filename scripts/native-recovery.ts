import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV2, LanguageModelV2StreamPart } from "@ai-sdk/provider-v5";
import { Agent } from "@mastra/core/agent";
import { createDurableAgent, globalRunRegistry } from "@mastra/core/agent/durable";
import { Mastra } from "@mastra/core/mastra";
import { databaseConfig } from "../src/config.js";
import { checkpointStore } from "../src/storage/bootstrap.js";

process.env.MASTRA_TELEMETRY_DISABLED = "true";
const root = fileURLToPath(new URL("../", import.meta.url));
const runtimePatch = JSON.parse(execFileSync(process.execPath, [resolve(root, "scripts/mastra-recovery-patch.mjs"), "--check"], { encoding: "utf8" }));
const [mode, suppliedRunId] = process.argv.slice(2);
if (mode && mode !== "crash") throw new Error("Usage: npm run repro:native");
const runId = suppliedRunId ?? randomUUID();
const checkpoint = checkpointStore(databaseConfig());
const model: LanguageModelV2 = {
  specificationVersion: "v2", provider: "native-fixture", modelId: "native-fixture", supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: "text", text: "Fixture complete." }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
  doStream: async () => {
    if (mode === "crash") {
      await new Promise<void>((complete) => process.stdout.write("NATIVE_FAULT_REACHED\n", () => complete()));
      process.kill(process.pid, "SIGKILL");
      await new Promise<void>(() => undefined);
    }
    return { stream: new ReadableStream<LanguageModelV2StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: "Fixture complete." });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      controller.close();
    } }) };
  },
};
const agent = createDurableAgent({ agent: new Agent({ id: "native-recovery-repro", name: "Native recovery reproduction", instructions: "Synthetic test only.", model }), cleanupTimeoutMs: 0 });
const mastra = new Mastra({ agents: { fixture: agent }, storage: checkpoint.storage, logger: false, recovery: { durableAgents: "off" } });
let stream: Awaited<ReturnType<typeof agent.stream>> | undefined;
let recovered = false;
let errorCode: string | undefined;
let failureFrames: string[] = [];
let snapshotShape: unknown;
try {
  if (!mode) {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/native-recovery.ts", "crash", runId], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45000);
    const signal = await new Promise<NodeJS.Signals | null>((complete, reject) => {
      child.once("error", reject);
      child.once("close", (_code, signal) => complete(signal));
    }).finally(() => clearTimeout(timeout));
    if (signal !== "SIGKILL" || !output.includes("NATIVE_FAULT_REACHED")) throw new Error("native_fault_not_reached");
    const workflows = await checkpoint.storage.getStore("workflows");
    const snapshot = await workflows?.loadWorkflowSnapshot({ workflowName: agent.getWorkflow().id, runId });
    if (snapshot?.status !== "running") throw new Error("native_running_snapshot_missing");
    snapshotShape = { activePaths: snapshot.activePaths, activeStepsPath: snapshot.activeStepsPath,
      context: Object.fromEntries(Object.entries(snapshot.context).map(([key, value]) => {
        const entry = value as Record<string, unknown>;
        return [key, { status: entry.status, keys: Object.keys(entry), payloadKeys: Object.keys(entry.payload ?? {}), outputKeys: Object.keys(entry.output ?? {}) }];
      })) };
  }
  stream = mode ? await agent.stream("Finish the fixture.", { runId, modelSettings: { maxRetries: 0 } }) : await agent.recover(runId);
  for await (const chunk of stream.output.fullStream) {
    if (chunk.type === "error") failureFrames.push(...[...JSON.stringify(chunk).matchAll(/\/@mastra\/core\/dist\/([A-Za-z0-9_./-]+:\d+:\d+)/g)].map((match) => match[1]!).slice(0, 8));
  }
  await globalRunRegistry.get(runId)?.workflowExecution;
  recovered = await stream.output.finishReason === "stop";
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  failureFrames.push(...[...(error instanceof Error ? error.stack ?? "" : "").matchAll(/\/@mastra\/core\/dist\/([A-Za-z0-9_./-]+:\d+:\d+)/g)].map((match) => match[1]!).slice(0, 8));
  errorCode = message === "Cannot read properties of undefined (reading 'messages')" ? "native_missing_messages_on_recover"
    : ["native_fault_not_reached", "native_running_snapshot_missing"].includes(message) ? message : "native_runtime_error_redacted";
} finally {
  await globalRunRegistry.get(runId)?.workflowExecution?.catch(() => undefined);
  stream?.cleanup();
  await mastra.shutdown();
  await checkpoint.end();
}
if (!mode) {
  const report = { createdAt: new Date().toISOString(), runId, mastraCore: "1.67.0", mastraPg: "1.25.0", runtimePatch, nativeRecoveryPassed: recovered, errorCode, failureFrames, snapshotShape,
    scope: "Real SIGKILL inside a native durable-agent model call, then recover in another process. No Gidorah backend, journal, executor, tools, provider calls or network target." };
  const directory = resolve(root, "comparison/results");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `native-recovery-${runId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ ...report, report: path }));
  if (!recovered) process.exitCode = 1;
}
