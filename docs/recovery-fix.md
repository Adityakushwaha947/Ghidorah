# Mastra crash-recovery patch

Date: 2026-09-18. Scope: Gidorah's synthetic counter fixture on `@mastra/core` **1.67.0** and `@mastra/pg` **1.25.0**. This is a locally maintained patch, not an upstream release or production certification.

## What was wrong

There were two related problems in the pinned Mastra runtime:

1. **Restart selected the wrong input.** The snapshot retained the active step's `payload`, including its serialized messages. The default engine used the preceding step's `output` for an active single-step restart instead. Snapshot pruning had already removed the messages from that older output. The minimal process-kill reproduction failed with `Cannot read properties of undefined (reading 'messages')`.
2. **Tool recovery lost a required model result.** The `collect-tool-results` mapping explicitly reads `getStepResult(llmExecutionStep.id)`. Running-snapshot pruning treated that completed model output as unused history and removed `messageListState`. Restoring the active step's input alone fixed the model-only reproduction, but the integrated recovery test still failed after resuming a tool. The later model/tool merge needs that saved model output too.

The fixture results isolated both problems: the native reproduction passed after the first change; the three-boundary integrated recovery test passed only after both changes. These findings apply to the exercised pinned code paths, not every Mastra engine or feature.

## The two changes

`scripts/mastra-recovery-patch.mjs` patches two statements in each published ESM/CommonJS agent bundle:

- In the default engine's single-step entry handler, use the existing saved-payload restoration helper for a step explicitly named in `restart.activeStepsPath`, as well as for an explicit resume. If no payload property exists, preserve the original previous-output fallback. A present `undefined` payload remains `undefined` rather than inventing input.
- In running-history pruning, retain the output of `DurableStepIds.LLM_EXECUTION`. Continue pruning its old payload, unrelated terminal outputs, echoed provider requests and other unused history. This keeps a model output required by a later workflow step; it does not turn snapshot pruning off.

Mastra still owns the agent loop and native restart. Gidorah still owns the journal, leases, budgets and execution checks. No production target was enabled; no error was relabeled as success; no recovery acceptance assertion was removed or skipped; no alternate reasoning loop was added.

## Reproducible installation

Patch identity: `gidorah-mastra-1.67.0-recovery-v1`.

- `npm install` / `npm ci` normally runs the project's `postinstall` hook, which applies the patch.
- `npm run patch:mastra` applies it explicitly, including after an installation with lifecycle scripts disabled.
- `npm run patch:check` checks the installed version and both complete bundle SHA-256 hashes without changing files.
- The CLI and integration-test npm command have patch prechecks. The native reproduction checks directly. Consumers invoking the backend directly must also verify the installation; importing the backend is not a patch installer.
- Unknown versions or modified bundles are rejected rather than patched approximately. Both bundles are validated before either is written. A partially interrupted installation can be rerun; verification must pass before execution.
- The two bundle source maps are not regenerated. The substitutions preserve line count; patched-line column mappings may differ.

| Bundle | Expected patched SHA-256 |
| --- | --- |
| ESM `dist/agent-Dk0N0Nlg.js` | `5dff0309c09c8c5a40f196882894535dadfad66aaffa9fc254b5e69b3079bb62` |
| CommonJS `dist/agent-CBKrAqsZ.cjs` | `e1d2cbc14b2badb02c90bf150733f1c2f4eb5fd32ac4ce9c0c98abcb360a5476` |

The installer also stores the original published hashes. Regression tests reconstruct those exact original bytes in temporary directories and exercise clean patch application, reapplication, missing-patch detection, version rejection and rejection before writes when another bundle differs. This is a dependency-bundle installation test, not a claim that a fresh network `npm ci` was performed.

## Regression and acceptance checks

`npm run test:recovery` contains eight offline tests: four installation/integrity checks and two behavioral checks for each module format. The behavioral checks exercise active restart, terminal-boundary restart, fresh execution, inactive steps, missing/undefined payloads, existing resume behavior and snapshot pruning without input mutation.

The original ten integration tests retain their assertions. In particular, the crash-recovery case must finish all three boundaries (`after-model`, `after-intent`, `after-result`), leave the counter at exactly one and record exactly five steps/six synthetic tokens. Separate real-kill tests must still block both uncertain boundaries (`after-dispatch`, `after-effect`) without further journal progress.

This public edition includes only the Mastra implementation, not the private side-by-side comparison or its reports. The configuration cases were adapted to its explicit local-only PostgreSQL policy; recovery and uncertain-action assertions remain intact. Run `npm run test:all`, `npm run test:comparison` and `npm run repro:native` to validate this edition. The helper suite is not a two-harness benchmark.

Native reports identify the runtime as locally patched. Local report files are excluded from Git; a reviewed public summary is in [validation](validation.md). Passing fixture checks do not grant production approval.

## Limits and rollout

- **Existing damaged snapshots are not repaired.** State removed by an older runtime cannot reliably be recreated. A previous failed run is not retroactively successful. Do not delete uncertainty records or launch replacement effects to pretend recovery worked; inspect and reconcile old runs separately.
- **Manual recovery, not automatic fleet scheduling.** These checks prove explicit recovery after real SIGKILL faults on the fixture. They do not prove Ctrl+C handling, every termination signal, scheduler takeover or every possible crash location. A deliberate stop/cancel is not automatically converted into a resumable crash.
- **No external exactly-once guarantee.** Unknown dispatched effects remain blocked. The counter fixture and its transaction boundaries do not certify remote commands or external services.
- **Checkpoint ownership remains a production gate.** Existing journal fencing is not proof that stale workers cannot advance authoritative native snapshots. Dedicated checkpoint fencing, isolated execution, tenant authorization, real-model accounting, independent finding verification and endurance testing remain required.
- **Maintain or retire deliberately.** Before upgrading Mastra, review the upstream default-entry and snapshot-pruning implementations, remove this patch only when equivalent behavior is established, and rerun native plus full integration tests. Do not weaken the version/hash guard to make an upgrade install. An upstream issue/PR can carry the minimal reproduction and tests; no upstream submission was made here.
