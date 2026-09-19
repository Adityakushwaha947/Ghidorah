# Provider-neutral model boundary: first implementation

Status: **library foundation with synthetic transport/journal tests; not a live provider gateway.** It is not wired into the fixture's Mastra adapter or CLI. No key is read, no paid request is made, and no target/tool is executed by this module.

`src/model/gateway.ts` implements the shared `ModelClient` interface around explicitly registered provider clients. It makes one model dispatch, not a reasoning loop. Mastra remains the owner of the investigator loop.

## Implemented path

1. Validate the exact model seam, finite settings, deadline, unique tools/calls, complete tool-result history and bounded canonical JSON. Reject unknown routes and unsupported sampling before allocating a dispatch.
2. Match requested tool schemas/descriptions to trusted registered Zod schemas. The model cannot replace a tool contract or add an execution capability. Copy the admitted request before the first asynchronous boundary.
3. Require an injected `ModelDispatchJournal` to reserve before calling the provider. Record request ID, route, provider, requested model, canonical request and digest. A committed replay returns its original response without another provider call.
4. Pass one cancellation signal/deadline through the client stream. Bound events, output bytes and call counts. Text and argument deltas are **uncommitted preview data**, never executable tool proposals or authoritative frontend events.
5. Validate non-decreasing cumulative usage; journal only changed totals, not repeated final totals. Reject usage over the reservation/output limit. Missing final usage is an error; unknown usage is recorded as unknown, never zero.
6. Require exactly one completed response followed by stream EOF. Bind request and permitted resolved-model identity, check final text/argument assembly and validate each completed call against its registered schema. A length-limited/refused response exposes no executable calls.
7. Commit the final response before publishing `completed`. Failed mandatory journal writes cannot yield successful completion. Provider errors are sanitized; cancellation, timeout, refusal and incomplete streams remain distinct.

There is no automatic provider retry or fallback. Refusal is a normal recorded response, **not** a signal to switch providers to evade safeguards. A separately approved provider selection can be supported later. Any availability retry must have a fresh dispatch ID and retain all original usage and uncertainty; it must not bypass an unresolved dispatch.

## Required storage implementation before live use

The journal interface is a mandatory dependency, not an optional logging callback. This increment intentionally supplies **no in-memory production journal and no live Postgres model-accounting adapter**. The in-memory journal exists only in tests. Therefore passing these tests does not prove durable provider accounting or crash recovery.

The accepted Postgres implementation must bind one gateway to a run/tenant/lease epoch and:

- Atomically check ownership, stop/deadline, cumulative caps and immutable request/route identity; allow at most one unresolved dispatch per run across all processes, not just this gateway instance.
- Reserve an accepted conservative input-token bound plus the enforced output bound before dispatch. Reject requests whose input usage cannot be bounded. A requested USD cap stays unsupported until an accepted pricing/cost ledger enforces it.
- Persist cumulative usage idempotently and reconcile final totals exactly once. Retain actual observed overages as failures, not successful budget compliance.
- Return a cached response only for the identical captured request and route under valid run authority. Reject changed payloads and blind replay after an uncertain dispatch, including attempts to evade uncertainty with a new ID.
- Commit response/failure and evidence consistently. Missing final usage retains the reservation and blocks new dispatch until trusted reconciliation. A failed failure-record write must leave the prior reservation visible for recovery.
- Bound database operations themselves. The gateway waits for reservation/commit acknowledgement rather than racing an unresolved write into a second state transition.

The gateway aborts transport on timeout or iterator closure. Consumers must drain or close iterators. A paused/unclosed iterator may leave the durable reservation pending; process loss requires journal recovery. A provider that ignores cancellation may continue billing, so abort alone never proves zero remaining cost. An accepted completion that commits concurrently with cancellation stays a committed fact; the executor must independently enforce stop/lease/budget before any tool dispatch.

## Next implementation order

1. Implement and failure-test the lease-fenced Postgres dispatch/usage journal and conservative input-budget policy.
2. Add provider adapters for the OpenAI API and OpenRouter with SDK retries disabled, pinned route configuration and mocked HTTP/SSE conformance tests. OpenAI API authentication is not a claim of Codex CLI/subscription support. Do not select an unapproved model/version or reuse credentials pasted into chat.
3. Run approved, finite-budget provider acceptance: text, tools, refusal, partial disconnect, cancellation, usage, resolved model identity and no hidden provider fallbacks. Claude and owned-serving adapters must pass the same seam tests before enablement.
4. Connect the accepted boundary to Mastra's model interface and the authoritative product journal. Keep all real execution disabled until the broker, scope/auth, evidence and independent verification gates pass.

Design references: OpenAI documents [function-call finalization](https://developers.openai.com/api/docs/guides/function-calling) and [stream events](https://developers.openai.com/api/docs/guides/streaming-responses). OpenRouter documents [usage frames, stream errors and cancellation limits](https://openrouter.ai/docs/api_reference/streaming). These informed the normalized boundary; this increment does not claim wire-level adapter acceptance against either service.
