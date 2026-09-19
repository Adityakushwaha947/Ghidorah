# Mastra crash-recovery patch

Updated: 2026-09-19. Scope: Ghidorah's counter fixture, including its gateway-backed model adapter, on `@mastra/core` **1.67.0** and `@mastra/pg` **1.25.0**. This is a locally maintained patch, not an upstream release or production certification.

## What was wrong

Three problems were reproduced in the pinned Mastra runtime:

1. **Restart selected the wrong input.** The snapshot retained the active step's `payload`, including its serialized messages. The default engine used the preceding step's `output` for an active single-step restart instead. Snapshot pruning had already removed the messages from that older output. The minimal process-kill reproduction failed with `Cannot read properties of undefined (reading 'messages')`.
2. **Tool recovery lost a required model result.** The `collect-tool-results` mapping explicitly reads `getStepResult(llmExecutionStep.id)`. Running-snapshot pruning treated that completed model output as unused history and removed `messageListState`. Restoring the active step's input alone fixed the model-only reproduction, but the integrated recovery test still failed after resuming a tool. The later model/tool merge needs that saved model output too.
3. **Recovery restored the model but omitted its tools.** The recovery registry entry contained a hydrated model but no `tools` or `baseTools`. `resolveRuntimeDependencies` treated it as complete and skipped rebuilding tools. On the gateway-backed loop, recovery therefore changed the captured request to `tools: []`; the durable request-digest check correctly rejected this as a different request. Real process-kill testing exposed this on 19 September. The request check was not weakened.

The fixture results isolated both problems: the native reproduction passed after the first change; the three-boundary integrated recovery test passed only after both changes. These findings apply to the exercised pinned code paths, not every Mastra engine or feature.

## The three changes

`apps/ghidorah/scripts/mastra-recovery-patch.mjs` patches two statements in each published ESM/CommonJS agent bundle and one statement in each durable-agent bundle:

- In the default engine's single-step entry handler, use the existing saved-payload restoration helper for a step explicitly named in `restart.activeStepsPath`, as well as for an explicit resume. If no payload property exists, preserve the original previous-output fallback. A present `undefined` payload remains `undefined` rather than inventing input.
- In running-history pruning, retain the output of `DurableStepIds.LLM_EXECUTION`. Continue pruning its old payload, unrelated terminal outputs, echoed provider requests and other unused history. This keeps a model output required by a later workflow step; it does not turn snapshot pruning off.
- Treat a registry entry as fully hydrated only when a `baseTools` or `tools` map is present as well as the model. Missing tools use Mastra's existing trusted-agent reconstruction path. An explicitly empty tool map remains valid; no additional tool is invented or granted.

Mastra still owns the agent loop and native restart. Gidorah still owns the journal, leases, budgets and execution checks. No production target was enabled; no error was relabeled as success; no recovery acceptance assertion was removed or skipped; no alternate reasoning loop was added.

## Reproducible installation

Patch identity: `gidorah-mastra-1.67.0-recovery-v2`.

- `bun install` / `bun install --frozen-lockfile` normally runs the project's `postinstall` hook, which applies the patch.
- `bun run patch:mastra` applies it explicitly, including after an installation with lifecycle scripts disabled.
- `bun run patch:check` checks the installed version and all four complete bundle SHA-256 hashes without changing files.
- The CLI and integration-test scripts have patch prechecks. The native reproduction checks directly. Since the 19 September hardening increment, backend execution also verifies the accepted installed bundle hashes before allocating a run. Importing the backend is not a patch installer.
- Unknown versions or modified bundles are rejected rather than patched approximately. All bundles are validated before any is written. A partially interrupted installation can be rerun; verification must pass before execution.
- Bundle source maps are not regenerated. The substitutions preserve line count; patched-line column mappings may differ.

| Bundle | Expected patched SHA-256 |
| --- | --- |
| ESM `dist/agent-Dk0N0Nlg.js` | `5dff0309c09c8c5a40f196882894535dadfad66aaffa9fc254b5e69b3079bb62` |
| CommonJS `dist/agent-CBKrAqsZ.cjs` | `e1d2cbc14b2badb02c90bf150733f1c2f4eb5fd32ac4ce9c0c98abcb360a5476` |
| ESM `dist/create-durable-agent-DFHwqN2K.js` | `01b5150913c4f620e47128375804052528b6066aae85298ae5180ad4281a9948` |
| CommonJS `dist/create-durable-agent-CfjlmNSr.cjs` | `e6cc47a6777178ce3b601c0b27576a5128b16e844b6e4d8679a67246270f43d0` |

The installer also stores the original published hashes. Regression tests reconstruct those exact original bytes in temporary directories and exercise clean patch application, reapplication, missing-patch detection, version rejection and rejection before writes when another bundle differs. This is a dependency-bundle installation test, not a claim that a fresh network `bun install --frozen-lockfile` was performed.

## Regression and acceptance checks

`bun run test:recovery` contains ten offline tests: four installation/integrity checks and three behavioral checks for each module format. The behavioral checks exercise active restart, terminal-boundary restart, fresh execution, inactive steps, missing/undefined payloads, existing resume behavior, snapshot pruning without input mutation, missing-tool rehydration and explicit empty tool maps.

`test/integration/gateway-runtime.test.ts` also kills separate Bun processes after committed provider output and after a committed tool result. A new process must recover with an identical model request, make only the two remaining mocked provider calls, charge 48 tokens total and leave the counter at one. This tests the real HTTP adapter/gateway/Mastra/journal path with a synthetic transport, not a paid provider's recovery guarantees.

The original ten integration tests retain their assertions. In particular, the crash-recovery case must finish all three boundaries (`after-model`, `after-intent`, `after-result`), leave the counter at exactly one and record exactly five steps/six synthetic tokens. Separate real-kill tests must still block both uncertain boundaries (`after-dispatch`, `after-effect`) without further journal progress.

This public edition includes only the Mastra implementation, not the private side-by-side comparison or its reports. The configuration cases were adapted to its explicit local-only PostgreSQL policy; recovery and uncertain-action assertions remain intact. Run `bun run test:all`, `bun run test:comparison` and `bun run repro:native` to validate this edition. The helper suite is not a two-harness benchmark.

Native reports identify the runtime as locally patched. Local report files are excluded from Git; a reviewed public summary is in [validation](validation.md). Passing fixture checks do not grant production approval.

## Limits and rollout

- **Existing damaged snapshots are not repaired.** State removed by an older runtime cannot reliably be recreated. A previous failed run is not retroactively successful. Do not delete uncertainty records or launch replacement effects to pretend recovery worked; inspect and reconcile old runs separately.
- **Manual recovery, not automatic fleet scheduling.** These checks prove explicit recovery after real SIGKILL faults on the fixture. They do not prove Ctrl+C handling, every termination signal, scheduler takeover or every possible crash location. A deliberate stop/cancel is not automatically converted into a resumable crash.
- **No external exactly-once guarantee.** Unknown dispatched effects remain blocked. The counter fixture and its transaction boundaries do not certify remote commands or external services.
- **Checkpoint hardening was added on 19 September.** Native workflow writes now lock/check the product lease in PostgreSQL, with stale-write, takeover, failure and deadline tests. This is separate from the bundle patch described here; see [the production plan](production-plan.md). Two-process pause/takeover, deployment-role and endurance acceptance remain open, as do isolated execution, tenant authorization, real-model accounting and integrated independent verification.
- **Maintain or retire deliberately.** Before upgrading Mastra, review the upstream default-entry, snapshot-pruning and registry-hydration implementations, remove this patch only when equivalent behavior is established, and rerun native plus full integration tests. Do not weaken the version/hash guard to make an upgrade install. An upstream issue/PR can carry the minimal reproduction and tests; no upstream submission was made here. A named maintainer and backup, upstream/fork decision and release/rollback ownership remain release requirements; see [operations](operations.md).
