import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { bundles, coreDirectory, managePatch, prepareBundle, replacements } from "../../scripts/mastra-recovery-patch.mjs";

const require = createRequire(import.meta.url);
const engines = [
  { name: "ESM", workflows: await import("@mastra/core/workflows"), agent: await import("@mastra/core/agent"), durable: await import("@mastra/core/agent/durable") },
  { name: "CommonJS", workflows: require("@mastra/core/workflows"), agent: require("@mastra/core/agent"), durable: require("@mastra/core/agent/durable") },
];

async function originalBundle(bundle) {
  let source = await readFile(resolve(coreDirectory, bundle.path), "utf8");
  for (const { before, after } of replacements) source = source.replace(after, before);
  return source.replace(/\n$/, "");
}

test("the installed ESM and CommonJS bundles match the reviewed patch hashes", async () => {
  assert.equal((await managePatch({ check: true })).verified, true);
});

test("patching pristine bundles is deterministic, idempotent and rejects tampering", async () => {
  for (const bundle of bundles) {
    const original = await originalBundle(bundle);
    const patched = prepareBundle(original, bundle);
    assert.notEqual(patched, original);
    assert.equal(prepareBundle(patched, bundle), patched);
    assert.throws(() => prepareBundle(`${patched}\n`, bundle), /Unrecognized Mastra bundle/);
  }
});

test("a clean installation applies both changes; check-only fails before patching", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gidorah-patch-"));
  try {
    await mkdir(resolve(directory, "dist"));
    await writeFile(resolve(directory, "package.json"), JSON.stringify({ name: "@mastra/core", version: "1.67.0" }));
    for (const bundle of bundles) await writeFile(resolve(directory, bundle.path), await originalBundle(bundle));
    await assert.rejects(managePatch({ directory, check: true }), /patch is missing/);
    assert.equal((await managePatch({ directory })).verified, true);
    assert.equal((await managePatch({ directory, check: true })).verified, true);
    await writeFile(resolve(directory, "package.json"), JSON.stringify({ name: "@mastra/core", version: "1.68.0" }));
    await assert.rejects(managePatch({ directory }), /requires exactly/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an unexpected second bundle prevents writing either bundle", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gidorah-patch-"));
  try {
    await mkdir(resolve(directory, "dist"));
    await writeFile(resolve(directory, "package.json"), JSON.stringify({ name: "@mastra/core", version: "1.67.0" }));
    const original = await originalBundle(bundles[0]);
    await writeFile(resolve(directory, bundles[0].path), original);
    await writeFile(resolve(directory, bundles[1].path), "unexpected bundle");
    await assert.rejects(managePatch({ directory }), /Unrecognized Mastra bundle/);
    assert.equal(await readFile(resolve(directory, bundles[0].path), "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const { name, workflows, agent, durable } of engines) {
  test(`${name}: restart uses only the active step's saved input; fresh, fallback and resume semantics remain intact`, async () => {
    class CaptureEngine extends workflows.DefaultExecutionEngine {
      async executeStep(parameters) {
        return { result: { status: "success", output: parameters.prevOutput }, stepResults: parameters.stepResults, mutableContext: this.buildMutableContext(parameters.executionContext) };
      }
      async executeMapping(parameters) { return this.executeStep(parameters); }
      async executeAgent(parameters) { return this.executeStep(parameters); }
      async executeTool(parameters) { return this.executeStep(parameters); }
    }
    const engine = new CaptureEngine({ options: { validateInputs: false, shouldPersistSnapshot: () => false } });
    const saved = { messageListState: { messages: ["saved assistant tool call"] } };
    const previous = { pruned: true };
    for (const type of ["step", "mapping", "agent", "tool"]) {
      for (const scenario of ["restart", "terminal-restart", "fresh", "inactive", "missing-payload", "undefined-payload", "resume"]) {
        const entry = type === "step" ? { type, step: { id: "active" } } : { type, id: "active" };
        const stepResults = { input: {}, previous: { status: "success", output: previous }, active: { status: scenario === "terminal-restart" ? "success" : "running", ...(scenario === "missing-payload" ? {} : { payload: scenario === "undefined-payload" ? undefined : saved }) } };
        const restart = ["fresh", "resume"].includes(scenario) ? undefined : { activeStepsPath: scenario === "inactive" ? {} : { active: [1] }, activePaths: [1], stepResults };
        const result = await engine.executeEntry({
          workflowId: "fixture", runId: "fixture-run", entry, prevStep: { type: "step", step: { id: "previous" } }, stepResults, restart,
          resume: scenario === "resume" ? { steps: ["active"], stepResults, resumePath: [1] } : undefined,
          executionContext: { workflowId: "fixture", runId: "fixture-run", executionPath: [1], stepExecutionPath: [], activeStepsPath: {}, suspendedPaths: {}, resumeLabels: {}, state: {} },
        });
        const expected = ["fresh", "inactive", "missing-payload"].includes(scenario) ? previous : scenario === "undefined-payload" ? undefined : saved;
        assert.equal(result.result.output, expected, `${type}: ${scenario}`);
      }
    }
  });

  test(`${name}: pruning retains model output needed after tool recovery without retaining all history`, () => {
    const fixture = durable.createDurableAgent({ agent: new agent.Agent({ id: "pruning-regression", name: "Pruning regression", model: { specificationVersion: "v2", provider: "fixture", modelId: "fixture", supportedUrls: {} } }) });
    const prune = fixture.getWorkflow().options.pruneSnapshot;
    const state = { messageListState: { messages: ["assistant tool call"] }, accumulatedSteps: ["prior turn"], stepResult: { reason: "tool-calls", request: "must not retain" } };
    const snapshot = {
      runId: "fixture-run", status: "running", activePaths: [3], activeStepsPath: { "durable-tool-call": [3] },
      context: {
        input: { ...state, __workflowKind: "durable-agent" },
        "durable-llm-execution": { status: "success", payload: state, output: state },
        "unrelated-history": { status: "success", payload: state, output: state },
        "durable-tool-call": { status: "running", payload: { toolCallId: "call-one" } },
      },
    };
    const original = structuredClone(snapshot);
    const pruned = prune({ snapshot, workflowStatus: "running" });
    assert.deepEqual(pruned.context["durable-llm-execution"].output.messageListState, state.messageListState);
    assert.equal(pruned.context["durable-llm-execution"].output.stepResult.request, undefined);
    assert.equal(pruned.context["durable-llm-execution"].payload.messageListState, undefined);
    assert.equal(pruned.context["unrelated-history"].output.messageListState, undefined);
    assert.equal(pruned.context["unrelated-history"].output.accumulatedSteps, undefined);
    assert.deepEqual(pruned.context["durable-tool-call"].payload, snapshot.context["durable-tool-call"].payload);
    assert.equal(pruned.context.input.__workflowKind, "durable-agent");
    assert.deepEqual(snapshot, original);
    const suspended = prune({ snapshot: { ...snapshot, status: "suspended" }, workflowStatus: "suspended" });
    assert.deepEqual(suspended.context["unrelated-history"].output.messageListState, state.messageListState);
  });
}
