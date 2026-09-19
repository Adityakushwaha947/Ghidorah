# Frontend integration guide

This is how a terminal UI, web client or headless runner talks to Ghidorah. It covers the contract that is stable today, the parts that are schema-defined but not yet produced by the backend, and the rules a client must follow so that it never shows a result the backend did not commit.

Audience: the team building the Mettle frontend. Read [architecture](architecture.md) first for the backend model.

## The one rule for clients

**Render committed backend records. Never infer success from model prose.**

A finding is confirmed when a `finding.update` event says so with an independent verification receipt. A run succeeded when `run.finished` says `completed`. A tool worked when `tool.result` says `ok: true`. Text from the model, a step summary, or the absence of an error are not evidence of anything.

## What you import

```ts
import { EventSchema, AgentControlSchema, RunConfigSchema, type Event, type AgentApi } from "gidorah/contracts";
```

`gidorah/contracts` is portable: Zod only, no Node, Postgres or Mastra. Its JSON Schemas are emitted to `dist/contracts/schema.json` for non-TypeScript clients. The `contractVersion` is `1.0.0`. Every request, event and control carries it, and the backend rejects any other value before doing anything else.

## The API surface

The backend exposes six operations. Today they are in-process calls on `GidorahBackend`. A network transport is not yet built, so a UI either runs in the same process as the backend or drives the CLI and parses its JSON lines.

| Operation | Purpose | Status |
| --- | --- | --- |
| `run(target, config)` | Start a run. Returns a handle with an event stream and a control function. | Fixture only |
| `recover(runId, context)` | Resume a run whose previous owner died. Same handle shape. | Works |
| `observe(runId, context)` | Second local subscriber to a live run, or replay of a finished one. | Same process only |
| `getArtifact(runId, ref, context)` | Fetch stored, digest-checked evidence bytes. | Works |
| `getPendingReview(runId, findingId, context)` | Fetch a finding awaiting human review. | Always `null` |
| `getReview(runId, findingId, context)` | Fetch a recorded review decision. | Always `null` |

## Starting a run

`RunConfig` is the request. Required fields: `contractVersion`, `capTokens`, `capSteps`, `capWallSec`, `approvalProfile`, `authorization`. Optional: `model`, `capabilities`, `change`, `targetKind`, `capUsd`.

What the backend accepts today:

| Field | Accepted now | Rejected with |
| --- | --- | --- |
| target | `fixture://counter` | `unsupported_profile` |
| model | `gidorah-fixture-v1` | `unsupported_profile` |
| capabilities | `["agentic_pentesting"]` or omitted | `unsupported_profile` |
| approvalProfile | `closed-world` | `unsupported_profile` |
| targetKind | `web` | `unsupported_profile` |
| change | omitted | `unsupported_profile` |
| capUsd | omitted | `unsupported_budget` |
| authorization | `{ asserted: true, scopeAllowlist: ["fixture://counter"] }` | `scope_denied` |
| unknown field | none | `invalid_config` |

The schema already knows six capabilities: `code`, `pull_requests`, `agentic_pentesting`, `secrets`, `supply_chain`, `dependency_firewall`. Declaring them in the contract does not enable them. Build the UI against the schema and expect `unsupported_profile` until each capability has an accepted implementation.

## The event stream

Events arrive in strict sequence order per run. Every event has `contractVersion`, `runId` and `seq`. Validate each one with `EventSchema` before applying it.

| Event | Meaning | Produced today |
| --- | --- | --- |
| `run.started` | First event of a fresh run. Carries target, mode, capabilities and caps. | Yes |
| `run.snapshot` | Full state at a sequence number. Authoritative; replaces local state. | Yes |
| `step` | The agent advanced. Summary is informational only. | Yes |
| `tool.call` | A tool proposal was admitted and recorded. Not proof it ran. | Yes |
| `tool.result` | The tool completed. `ok`, a summary and an `artifactRef` for evidence. | Yes |
| `budget` | Caps and spend after a charge. | Yes |
| `error` | Something failed. `fatal: true` means the stream ends. | Yes |
| `run.finished` | Terminal outcome with cleanup status and finding counts. | Yes, counts always zero |
| `coverage` | A surface was checked, cleared or ruled out. | Not yet |
| `dependency.decision` | An install policy decision. Separate from findings. | Not yet |
| `finding.candidate` | A new candidate finding with pending verification. | Not yet |
| `finding.update` | Verification result: confirmed, discarded, or still candidate. | Not yet |
| `approval.request` | A destructive action needs a human decision. | Not yet |
| `review.request` | An inconclusive finding needs a human reviewer. | Not yet |

### Applying events

Use a reducer with these rules. The backend ships one for the fixture in `src/foundation/reducer.ts`; a production client implements the same rules over the full event set.

1. A `run.snapshot` replaces local state unconditionally, even if its `seq` is lower than what you hold.
2. If you have no state, the first event must be `run.started` or `run.snapshot`. Anything else is `missing_snapshot`.
3. An event with `seq` at or below your current `seq` is a duplicate. Ignore it.
4. An event with `seq` greater than current plus one is a gap. Stop applying and request a snapshot.
5. An event from a different `runId` is `run_mismatch`. Never merge runs.
6. After `run.finished` or a snapshot with `terminal`, any further transition is `terminal_transition`. Reject it.
7. A second `run.started` is `duplicate_start`.

### Reconnecting

There is no reconnect protocol yet. If your stream breaks, call `observe` with the run ID. You receive a fresh `run.snapshot` and then live events from that point. If the backend process that owned the run is gone, `observe` throws `unsupported_attach` for a live run; call `recover` instead and the new process takes ownership.

## Controls

Send controls through the handle's `control` function. Every control carries `contractVersion`.

| Control | Effect today |
| --- | --- |
| `stop` | Requests a stop. The backend aborts in-flight work, records the request, and finishes with outcome `stopped`. Accepted at any time. |
| `pause`, `resume` | Schema-valid, rejected with `unsupported_control`. |
| `approve` with `allow` or `deny` | Schema-valid, rejected with `unsupported_control`. |
| `review` with `confirm` or `reject` | Schema-valid, rejected with `unsupported_control`. |

A stop is not a crash. A stopped run is terminal and is not resumable.

## Terminal outcomes and exit codes

`run.finished` has four outcomes. The CLI maps them to exit codes; a headless client should do the same.

| Outcome | Meaning | Exit |
| --- | --- | --- |
| `completed` | The agent finished normally within budget. | 0 |
| `stopped` | A stop control, a budget cap, or the wall-clock deadline ended the run. | 1 |
| `failed` | The runtime or a mandatory journal write failed. Message is redacted. | 1 |
| `incomplete` | Reserved. Not produced today. | 1 |

A fatal `error` event without a following `run.finished` means the backend lost ownership or storage. The run has no terminal state and needs `recover`. Do not display it as failed; display it as needing recovery.

`cleanupOk: false` means the run ended but the backend could not confirm cleanup. Surface this prominently. On a real target it means residual footprint.

## Findings, when they arrive

The finding contract is defined and tested but no backend path produces findings yet. Build against it now so nothing changes when it lights up.

A finding has a `claim` from a fixed list: `vulnerability`, `weak_cryptography`, `configuration_violation`, `secret_exposure`, `credential_validity`, `advisory_match`, `dependency_reachability`, `dependency_exploitability`, `malicious_package`. It carries a `capability`, `evidence` with a revision, and a `verification` block.

Verification has a `result`: `pending`, `pass`, `fail` or `needs_human`. A `pass` or `fail` must carry a `method`, an `artifactRef` and a `receipt` naming the authority: `gyms_oracle`, `independent_check` or `human`. The schema rejects a confirmed finding without a receipt. The backend rejects a receipt whose authority is not independently trusted. The frontend rejects nothing it did not receive as a committed event.

Display rules that follow from this:

- Show the precise claim, not a generic "vulnerability found". An `advisory_match` is not an exploit.
- Show the verification method and authority next to the status.
- `needs_human` is a queue item, not a result. Pair it with the `review.request` that binds it.
- `dependency.decision` is a policy outcome. Never render it in the findings list.

## Budget display

`caps` and `spent` have `tokens`, `steps` and `wallSec`. `usd` is optional and not metered today. Show spend against caps as fractions, not percentages of an estimate. Wall time is enforced by the backend deadline, so a client should not enforce its own.

## Evidence

Every `tool.result` names an `artifactRef`. Fetch bytes with `getArtifact`. The response says whether the content was redacted. Artifacts are digest-checked on read; a mismatch throws rather than returning altered bytes. Cache by `runId` plus `artifactRef`; they are immutable.

## Driving the CLI instead

Until a transport exists, the simplest integration is the CLI. Commands: `init`, `fixture`, `recover <runId>`, `inspect <runId>`. Runs print one JSON event per line on stdout; diagnostics go to stderr. `inspect` prints the snapshot and the action table for a run. SIGINT and SIGTERM send a stop control.

## What is not built

- Network API and authentication. Everything is in-process or CLI.
- Cross-process live attachment. `observe` works only in the owning process.
- Reconnect and durable delivery. Rebuild from snapshot.
- Approvals, reviews, pause and resume at runtime.
- Any producer of findings, coverage, dependency decisions or review requests.
- A final result document with report export.

The ordered list of what unblocks each of these is gate P9 and P10 in [the production plan](production-plan.md).
