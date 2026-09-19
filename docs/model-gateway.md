# Provider-neutral model boundary: first implementation

Status: **gateway and lease-fenced Postgres dispatch journal are wired into the counter fixture's Mastra adapter and optional live CLI route. This is not customer execution or complete billing integration.** The module never reads a key from a file; the acceptance script takes `OPENROUTER_API_KEY` from the process environment only. Bun itself may load the working directory's `.env`. The latest hardening/recovery tests use synthetic transports, not paid calls; the earlier live acceptance below is historical evidence for its recorded version.

## Implemented on 19 September 2026

- `apps/ghidorah/src/storage/model-dispatch-journal.ts`: `PostgresModelDispatchJournal` implements the required journal on top of the run record. Every operation locks the run row and verifies lease owner and epoch. New dispatches also enforce stop and wall-time. Settlement retains actual observations and failure/completion records even when stop/deadline arrives during the provider call; stopping cannot erase already incurred usage. One unresolved dispatch is allowed per run. The development reservation uses a byte-based input heuristic plus `maxOutputTokens`, checked against the remaining cap; the heuristic still needs model-specific acceptance. Completion charges the run once and appends a budget event. Unknown final usage keeps the reservation and blocks further dispatch/recovery pending trusted reconciliation. Observed overages are preserved rather than silently dropped. Reconciliation can settle an outstanding stopped run, records actual above-cap usage rather than pretending it was within budget, and sets stop to prevent more work. Final usage cannot decrease previous observations or charge twice. Ten database tests cover these behaviors, replay, mismatch, budget bounds and stale leases. Reconciliation is a trusted code operation, not a model or HTTP endpoint; provider billing-receipt authentication is still required.
- `packages/model/src/openrouter.ts`: `OpenRouterClient` implements `ModelClient` over one streaming Chat Completions request with native fetch. No retries or fallback. A nonempty upstream pin and the canonical OpenRouter HTTPS endpoint are mandatory; credential-bearing redirects are denied. Raw stream size/frame count, usage integers, choice count and tool indices are bounded. Final usage and `[DONE]` are required. Conflicting finish reasons, malformed frames and mismatches between `stop`/`tool_calls` and assembled calls fail closed. A truncated/refused response exposes no executable tool call. Transport failures are sanitized. Unit tests use a fake transport.
- `apps/ghidorah/scripts/openrouter-acceptance.ts` (`bun run acceptance:openrouter`): finite-budget live run through gateway and Postgres journal on the pinned route `z-ai/glm-4.7`. Passed on 19 September 2026: text completion, one finalized tool call in one HTTP request, replay served from the journal without a provider call, a 1 ms timeout recorded as unresolved, and a following dispatch blocked. Two HTTP calls, 355 run tokens, estimated spend $0.0005.

### Upstream pinning is mandatory

OpenRouter load-balances one model across several upstream providers. In three identical probes at a 16-token cap, one upstream returned 169 completion tokens. The gateway refused that response as an overage, which is the intended behaviour, and the acceptance failed until the route was pinned. `OpenRouterClient` therefore accepts `upstreams`, sent as `provider: { order, allow_fallbacks: false, require_parameters: true }`. Treat an unpinned OpenRouter route as a hidden provider fallback and do not enable it. The acceptance pins `DeepInfra`, which honours `max_tokens`, `seed` and tools at list price.

### Reasoning models and output budgets

GLM 4.7 spends hidden reasoning tokens against `max_tokens`. A 16-token cap produced `length` finishes with no visible text. Give reasoning routes realistic output budgets and expect `length` as a normal recorded outcome, not an error.

`packages/model/src/gateway.ts` implements the shared `ModelClient` interface around explicitly registered provider clients. It makes one model dispatch, not a reasoning loop. Mastra remains the owner of the investigator loop.

## Implemented path

1. Validate the exact model seam, finite settings, deadline, unique tools/calls, complete tool-result history and bounded canonical JSON. Reject unknown routes and unsupported sampling before allocating a dispatch.
2. Match requested tool schemas/descriptions to trusted registered Zod schemas. The model cannot replace a tool contract or add an execution capability. Copy the admitted request before the first asynchronous boundary.
3. Require an injected `ModelDispatchJournal` to reserve before calling the provider. Record request ID, route, provider, requested model, canonical request and digest. A committed replay returns its original response without another provider call.
4. Pass one cancellation signal/deadline through the client stream. Bound events, output bytes and call counts. Text and argument deltas are **uncommitted preview data**, never executable tool proposals or authoritative frontend events.
5. Validate non-decreasing cumulative usage; journal only changed totals, not repeated final totals. Reject usage over the reservation/output limit. Missing final usage is an error; unknown usage is recorded as unknown, never zero.
6. Require exactly one completed response followed by stream EOF. Bind request and permitted resolved-model identity, check final text/argument assembly and validate each completed call against its registered schema. A length-limited/refused response exposes no executable calls.
7. Commit the final response before publishing `completed`. Failed mandatory journal writes cannot yield successful completion. Provider errors are sanitized; cancellation, timeout, refusal and incomplete streams remain distinct.

There is no automatic provider retry or fallback. Refusal is a normal recorded response, **not** a signal to switch providers to evade safeguards. A separately approved provider selection can be supported later. Any availability retry must have a fresh dispatch ID and retain all original usage and uncertainty; it must not bypass an unresolved dispatch.

## Storage requirements and what the Postgres journal satisfies

The journal interface is a mandatory dependency, not an optional logging callback. The in-memory journal exists only in tests. The Postgres implementation above binds one gateway to a run and lease epoch and satisfies the points below, with two open items: the input bound is a byte heuristic, not a tokenizer, and there is no USD ledger. The original requirements, retained for review:

- Atomically check ownership, stop/deadline, cumulative caps and immutable request/route identity; allow at most one unresolved dispatch per run across all processes, not just this gateway instance.
- Reserve an accepted conservative input-token bound plus the enforced output bound before dispatch. Reject requests whose input usage cannot be bounded. A requested USD cap stays unsupported until an accepted pricing/cost ledger enforces it.
- Persist cumulative usage idempotently and reconcile final totals exactly once. Retain actual observed overages as failures, not successful budget compliance.
- Return a cached response only for the identical captured request and route under valid run authority. Reject changed payloads and blind replay after an uncertain dispatch, including attempts to evade uncertainty with a new ID.
- Commit response/failure and evidence consistently. Missing final usage retains the reservation and blocks new dispatch until trusted reconciliation. A failed failure-record write must leave the prior reservation visible for recovery.
- Bound database operations themselves. The gateway waits for reservation/commit acknowledgement rather than racing an unresolved write into a second state transition.

The gateway aborts transport on timeout or iterator closure. Consumers must drain or close iterators. A paused/unclosed iterator may leave the durable reservation pending; process loss requires journal recovery. A provider that ignores cancellation may continue billing, so abort alone never proves zero remaining cost. An accepted completion that commits concurrently with cancellation stays a committed fact; the executor must independently enforce stop/lease/budget before any tool dispatch.

## Next implementation order

1. Done: lease-fenced Postgres dispatch and usage journal with failure tests.
2. Done for OpenRouter with a pinned upstream; mocked SSE conformance tests in place. An OpenAI API adapter is not yet written. Do not select an unapproved model or reuse credentials pasted into chat.
3. Partially done: text, tools, cancellation, usage, replay and resolved model identity passed live on one route. Refusal and mid-stream disconnect were not exercised live. Claude and owned-serving adapters must pass the same seam tests before enablement.
4. Done for the counter fixture: `GatewayLanguageModel` in `apps/ghidorah/src/runtime/gateway-model.ts` adapts Mastra's model interface to the gateway, and `PostgresModelDispatchJournal` is the journal. A `CounterModelProfile` pins route, input-bound revision, output cap and timeout, and its digest becomes the run's runtime version, so a run created on one route cannot be recovered on another. `bun run cli fixture-live` runs the counter on `z-ai/glm-4.7`. Four database tests drive the full loop through a mocked HTTP provider: completion with charged usage, a charged refusal without tools, a cut stream leaving uncertainty, and real process kills followed by committed-response/result reuse. The latter exposed a third pinned Mastra recovery defect; see [the patch](recovery-fix.md). Real execution beyond the fixture stays disabled until the broker, scope/auth, evidence and independent verification gates pass.

### Mastra call shape

Mastra stamps `providerOptions.mastra.createdAt` on every message part. The adapter ignores that namespace and refuses any other provider namespace. It never copies provider options into the canonical request, which is what keeps replay digests stable across recoveries. Tool definitions offered by Mastra must match the gateway's registered tools by name, description and JSON schema; the adapter refuses anything else rather than forwarding a tool contract the gateway did not register.

Design references: OpenAI documents [function-call finalization](https://developers.openai.com/api/docs/guides/function-calling) and [stream events](https://developers.openai.com/api/docs/guides/streaming-responses). OpenRouter documents [usage frames, stream errors and cancellation limits](https://openrouter.ai/docs/api_reference/streaming). These informed the normalized boundary. USD reservation, provider invoice reconciliation, live failure tests and other provider adapters remain open; passing mocked calls is not proof of those capabilities.
