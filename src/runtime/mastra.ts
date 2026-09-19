import { Agent } from "@mastra/core/agent";
import { createDurableAgent, globalRunRegistry } from "@mastra/core/agent/durable";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { FixtureExecutor, type FixtureHooks } from "../execution/fixture-executor.js";
import { GidorahError } from "../foundation/errors.js";
import type { Lease, PostgresJournal } from "../storage/journal.js";
import type { CheckpointStore } from "../storage/bootstrap.js";
import { JournaledFixtureModel, type BoundaryGuard } from "./fixture-model.js";

process.env.MASTRA_TELEMETRY_DISABLED = "true";

export async function runFixtureAgent(journal: PostgresJournal, checkpoint: CheckpointStore, lease: Lease, signal: AbortSignal, hooks: FixtureHooks = {}): Promise<void> {
  const controller = new AbortController();
  const runtimeSignal = AbortSignal.any([signal, controller.signal, checkpoint.failureSignal]);
  const executor = new FixtureExecutor(journal, lease, runtimeSignal, hooks);
  const inFlight = new Set<Promise<unknown>>();
  let boundaryFailure: unknown;
  const guard: BoundaryGuard = async (operation) => {
    checkpoint.assertHealthy();
    if (boundaryFailure) throw boundaryFailure;
    const pending = operation();
    inFlight.add(pending);
    try { return await pending; }
    catch (error) { boundaryFailure ??= error; controller.abort(); throw error; }
    finally { inFlight.delete(pending); }
  };
  const tools = Object.fromEntries(["fixture_increment", "fixture_read"].map((name) => [name, createTool({
    id: name,
    description: name === "fixture_increment" ? "Increment the isolated synthetic fixture counter once." : "Read the isolated synthetic fixture counter.",
    inputSchema: z.strictObject({}), outputSchema: z.string(),
    execute: (input, context) => guard(() => executor.execute(context?.agent?.toolCallId, name, input)),
  })]));
  const agent = createDurableAgent({
    agent: new Agent({ id: "mettle-fixture", name: "Mettle fixture", model: new JournaledFixtureModel(journal, lease, guard, hooks), tools,
      instructions: "Development fixture only. Operate the registered counter, never external systems. This run cannot confirm security findings.",
    }), maxSteps: 100, cleanupTimeoutMs: 0,
  });
  const mastra = new Mastra({ agents: { fixture: agent }, storage: checkpoint.storage, logger: false, recovery: { durableAgents: "off" } });
  let stream: Awaited<ReturnType<typeof agent.stream>> | undefined;
  let streamFailure = false;
  try {
    const workflows = await checkpoint.storage.getStore("workflows");
    const saved = await workflows?.loadWorkflowSnapshot({ workflowName: agent.getWorkflow().id, runId: lease.runId });
    stream = saved
      ? await agent.recover(lease.runId, { abortSignal: runtimeSignal })
      : await agent.stream("Increment the synthetic counter once, read it, and finish.", {
        runId: lease.runId, abortSignal: runtimeSignal, maxSteps: 100, toolCallConcurrency: 1, modelSettings: { maxRetries: 0 },
      });
    for await (const chunk of stream.output.fullStream) {
      if (chunk.type === "error" || chunk.type === "tool-error") streamFailure = true;
    }
    await globalRunRegistry.get(lease.runId)?.workflowExecution?.catch((error: unknown) => { throw boundaryFailure ?? error; });
    checkpoint.assertHealthy();
    if (boundaryFailure) throw boundaryFailure;
    if (streamFailure) throw new GidorahError("runtime_failed", "The Mastra fixture runtime failed; no successful result is invented.");
    if (!signal.aborted && await stream.output.finishReason !== "stop") throw new GidorahError("runtime_incomplete", "The fixture runtime did not finish normally.");
  } catch (error) {
    throw boundaryFailure ?? error;
  } finally {
    controller.abort();
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    await globalRunRegistry.get(lease.runId)?.workflowExecution?.catch(() => undefined);
    stream?.cleanup();
    await mastra.shutdown();
  }
}
