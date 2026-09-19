# Ghidorah: Mettle production implementation plan

Reviewed 19 September 2026. **Production release remains blocked.** This is an implementation and acceptance map, not a launch announcement. The executable backend still admits only the synthetic counter fixture.

## Requirements reviewed

The source is `mettal-product.zip`, archive SHA-256 `05ed60d31f1fdde58e22903941cff95dfdd96609feea7379bbf4c7650bee230b`. Its fifteen Markdown sources cover positioning/overview, Agent specification/implementation/frontend, Gyms specification/implementation/backlog, Model specification/implementation, and their indexes. The older `mettle-agent.zip` and duplicate `mettle-agent (1).zip` contain the older Agent-only set; they are not the baseline for this work. The editable Markdown was read; matching PDFs were not regenerated or independently compared.

The ZIP's build-state descriptions are dated 17 September. They are not a current audit of the separate Gyms repository. Obtain that team's latest accepted implementation and evidence rather than rebuilding already-completed components or assuming the old defects remain unfixed.

Authoritative anchors:

| Source | Role in this backend |
| --- | --- |
| Agent spec §0, §2a | One thin Mastra investigator; no custom reasoning loop, automatic agent network or self-grading |
| Agent spec §6 | Core 1.0.0; request/event/control, six claim classifications, Finding receipts and state transitions |
| Agent spec §6a | Oracle 3.0.0, registry 2.0.0, ModelClient 1.0.0; exact versions and immutable identities |
| Agent spec §10–13 | Containment, evidence, customer-data readiness, recovery and actual framework acceptance |
| Agent plan M0, §15.2 | Protected M0 integration and the trusted JSON bridge |
| Agent plan §16 | Initial authorization/tenant-isolation workflow, source/build binding, repair and regression export |
| Frontend spec §9 | Headless result/exit policy, snapshots, stop, recovered approval denial and signal behavior |
| Gyms spec §4–8 and backlog B-01–B-17 | Independent verification, lifecycle, evidence, registered ranges and authorization predicates |
| Model spec §3–10 | Shared inference seam; separate training records, eligibility, lineage and promotion |

## Architecture to build

1. **Clients:** the team's terminal UI and a headless client import Ghidorah contracts. Neither imports Mastra display state or decides whether a finding is confirmed.
2. **Trusted application boundary:** authenticate an engagement/user, resolve an immutable target/profile, validate implemented capabilities and authorization, then admit a run. An operator checkbox or allowlist is not independent target authorization.
3. **Durable execution:** one Mastra investigator per run. Ghidorah owns execution leases, budgets, action/cleanup journals, snapshots and evidence. PostgreSQL remains the selected store; no return to a second harness is needed for this increment.
4. **Model boundary:** one pinned ModelClient route and capture/accounting boundary. Hosted/open-weight providers and later owned serving must pass the same protocol, usage, cancellation and refusal fixtures. No hidden helper-model route or automatic provider fallback.
5. **Controlled execution broker:** semantic tools request bounded operations. A separate trusted provisioner owns Docker/network setup. Tool containers receive neither database/provider credentials nor the Docker socket or verifier authority. Browser contexts alone are not containment.
6. **Evidence:** record intent before effects; commit bounded redacted observations and immutable provenance. Keep encrypted originals under separate access/retention controls. Resolve uncertain effects before replay; never claim external exactly-once execution.
7. **Verification:** a trusted adapter, not a model tool response, authenticates the Gyms verdict or accepted independent checker result. Bind policy, candidate, evidence, task/instance/reset, attempt and execution path. Persist admitted Finding transitions atomically with events.
8. **Delivery:** reports and the UI retain the precise claim, method, authority and policy. Install policy decisions remain separate from vulnerability findings. Gyms exports complete eligible episodes; Model owns training admission and promotion.

These are intended trust boundaries, not eight already-deployed services. Keep the current implementation small; split deployment processes where credentials and execution authority actually require separation.

## Implemented in this increment

### Native checkpoint ownership

`apps/ghidorah/src/storage/checkpoint-fence.ts` installs a checksummed migration after native tables initialize. Both native workflow rows (`durable-agentic-loop` and `durable-agentic-execution`) are guarded. Each execution receives a separate pool with a fixed run/owner/epoch identity. A PostgreSQL trigger locks the product run row and checks its owner, epoch, expiry and terminal state in the checkpoint transaction. Lease takeover therefore cannot race between an application-level check and a later checkpoint commit.

Missing/mismatched identities, expired owners, cross-run writes and terminal overwrites fail. Native deletion/truncation is denied; Mastra's best-effort snapshot deletion is intentionally prevented so recovery evidence remains available. This increases retained storage: an authorized retention/archival path is still required before deployment. Initialization is explicit (`bun run db:init`); ordinary execution does not silently migrate tables. Missing/changed/disabled guards block execution before a run is created.

`ObservedCheckpointWrites` uses Mastra's public PostgreSQL workflow domain extension. Failed mandatory saves/updates abort the execution and cannot be swallowed into successful completion. The backend verifies the accepted Mastra bundle hashes even when a library caller bypasses the package scripts. The earlier pinned recovery patch is still required; this work does not remove or expand that bundle patch.

**Threat model:** this fences stale trusted execution workers. It is not tenant authentication, a sandbox, or protection from a database administrator/table owner who can change triggers or session settings. Separate migration/application roles, least privilege, production TLS and operational recovery remain open. New Mastra persistence domains or dependency versions require renewed inspection and tests.

### Active wall-time enforcement

The backend arms cancellation using the persisted run's remaining wall budget, including elapsed time before recovery. This cancels an abort-aware pending fixture tool without waiting for another dispatch. Steps/tokens remain journal-enforced. Real provider streaming and external subprocess termination are still unimplemented and unaccepted.

### Claim and receipt foundation

`packages/foundation/src/findings.ts` adds strict classification schemas for all six capabilities and the specified claim levels, verification receipts, and separate install decisions. The independent-admission function checks original candidate/subject digests, run capability, trusted policy/authority, freshness, recorded tool provenance and redacted artifact hashes. A scanner advisory cannot become an exploit claim, a policy block cannot become a malware finding, and the automatic path cannot accept a human receipt.

**Important:** schema validation does not authenticate a producer. Only trusted application code may supply the admission context and evidence resolvers; do not expose it as a model-callable confirmation endpoint. The current fixture does not call an oracle, persist Findings or emit Finding events. Its counts remain zero. The new tests use explicitly synthetic authorities/evidence. The full event/reducer/report/UI/Model round-trip, durable verification attempts, human workflow and authenticated checker transport are not implemented by this library addition.

### Repeatable verification

`bun run verify` runs typecheck, build, unit tests, recovery-patch tests, PostgreSQL integration tests, the original 100 deterministic evaluations, report-helper tests and native SIGKILL recovery. A least-privilege GitHub Actions workflow uses pinned action commits and a disposable PostgreSQL service. The workflow has been added locally; no remote CI result is claimed until it runs on GitHub. Its PostgreSQL service tag remains a moving major tag, not an accepted production image digest.

## Remaining work, in execution order

### Review follow-up: shared contracts and model boundary

The external review inspected commit `276a4ee`, before checkpoint fencing. The local base for this follow-up is `5c52fbe`, which includes the earlier hardening. Historical validation/PDF results remain historical, not evidence for changed source. No PDF was regenerated.

The new `@ghidorah/contracts` entry point contains portable core, Finding, Oracle, registry and ModelClient definitions, generated declarations/JSON Schemas and an explicit drift manifest. Backend digest/authority admission stays separate and stronger. This is a locally pinned acceptance candidate, not cross-team release approval. The existing fixture continues rejecting non-fixture execution and findings.

The new provider-neutral gateway validates and journals a single dispatch through required client/storage interfaces, bounds streams, validates finalized calls, handles cancellation and refuses to fabricate usage. Tests use synthetic clients and a test-only journal. Real OpenAI/OpenRouter adapters, durable provider accounting, conservative input reservation, cost enforcement and the Mastra wiring remain open. See [contracts](../packages/contracts/README.md) and [model gateway](model-gateway.md). Do not treat these library additions as live-model acceptance or an isolated execution broker.

| Gate | Current status | Concrete next implementation and required proof |
| --- | --- | --- |
| P1. Foundation recovery | Partial; new fencing and deadline tests pass locally | Two-process pause/takeover/resume race; real provider/subprocess stop; approval/finding recovery; storage outage/restore; 200+ tool calls and approximately two-hour endurance with representative payloads |
| P2. Complete core contract | Portable schemas/types and local drift gate added; consumer acceptance pending | Durable candidate/receipt/install-decision tables and atomic event transitions; full reducer/snapshots; cross-language/cross-team fixtures and report round-trip; evidence-preserving legacy import; unsupported connectors still rejected |
| P3. ModelClient adapter | Gateway wired into the Mastra loop for the counter fixture; Postgres dispatch journal; OpenRouter adapter; live acceptance on `z-ai/glm-4.7` pinned to one upstream; mocked refusal and disconnect cases pass end to end | OpenAI adapter; live refusal and disconnect on a real provider; tokenizer-based input reservation; USD ledger; finite test budget per run |
| P4. Gyms seams | Not integrated here | Consume authenticated `/v3/verify` and `/v2/ranges/resolve` from trusted configuration; pin schema/manifest/predicate versions; canonical request journal and immutable attempts; test conflict, in-progress, stale reset, revoked eligibility and uncertain effects |
| P5. Isolated executor | Not implemented | Dedicated Linux/Docker path; non-root run container, resource caps, denied host/control-plane access; enforce direct-IP/IPv6/DNS/redirect/non-HTTP egress; independent SSRF-pivot and escape tests; fail startup without isolation |
| P6. Cleanup/action lifecycle | Counter only | Durable allocation and mutation intents, idempotent resource identities, trusted reconciliation, cancellation and residual-footprint reports; kill before/after allocation acknowledgement without leaks or blind replay |
| P7. Evidence/data security | Digest-checked numeric fixture only | Capture-time redaction, encrypted originals and opaque credentials, provenance/grounding, bounded output/context views, expiry-aware replay, retention/deletion/backup handling; seeded secrets and failed writes never produce a clean assessment |
| P8. Engagement access | Not implemented | Authenticated sessions, engagement-scoped authorization/storage/execution, read/control/export audit, least-privilege credentials; denied cross-engagement access and prompt-injection boundary tests |
| P9. Approvals and reviews | Rejected by fixture | Persist approvals bound to immutable action/effect/scope, default deny, reject stale decisions; recovery restores pending approvals and headless denies them; reviews bind same claim/evidence and never override infrastructure failure |
| P10. Headless and frontend contract | Basic fixture CLI only | FinalResult, documented exit precedence, clean stdout/stderr, broken-pipe/SIGINT/SIGTERM handling, recovered findings/approvals, report export; coordinate with existing frontend rather than replacing its renderer |
| P11. M0 acceptance | Not performed | Accepted protected task → grounded candidate → independent verdict → fresh reset/reproduction → scored export → Model consumer validation on the exact same versions; preserve every error and attempt |
| P12. Authorization pilot | Not implemented here | Gyms B-17 app/predicates and approved permission policy; identity health, tenants/object ownership, source/base/head/build bindings, vulnerable/corrected/benign controls, repair proposal and buyer-runnable regression pack |
| P13. Customer release | Blocked | Agent §11/§11a accepted configuration, access/data-use approval, retention/deletion exercise, dependency/use-rights register, authenticated deployment, least-privilege DB roles, backup/restore, load/soak, monitoring and incident/rollback drill |
| P14. Owned model | Separate Model track | Eligible training families, exact token recorder, training/lineage/evaluation/serving gates; not required to deliver the existing-model Agent pilot |

Work on schemas, mocks and owned synthetic fixtures can continue before real service handoff. Mock verdicts are never production confirmations. The M0 family and B-17 development suite are not training data. Broader Code/PR/scanner/firewall features require their own accepted coverage; listing six schema variants does not ship six products.

## External inputs before real integration

- Latest Gyms source revision and accepted runtime/evidence bundle, including model-capable containment; the ZIP is not proof of today's service readiness.
- Exact oracle/registry endpoint configuration and authentication delivery mechanism, compatible fixtures, registered task/instance/reset and predicate manifests.
- Approved model/provider identifier and finite test budget. Supply credentials through the deployment's secret mechanism, never chat or Git. Previously exposed credentials must not be reused.
- Dedicated Linux/Docker acceptance environment and non-shared database/storage. Do not convert the ProVue staging database into a customer agent execution store.
- For a customer pilot: approved scope, permission policy, test identities, data-processing/retention arrangement and accountable reviewer.

No paid model calls, customer ingestion, live target execution, deployment, commit or push is included in this increment. Keep live execution disabled until the corresponding gates pass; a boolean configuration flag is not an acceptable shortcut.

## Primary implementation references

The implementation was checked against installed `@mastra/core` 1.67.0 / `@mastra/pg` 1.25.0, not inferred from latest examples. Mastra documents the supplied-pool and domain storage boundaries in its [PostgreSQL integration](https://mastra.ai/integrations/databases/postgresql). The fence relies on PostgreSQL [row-lock transaction semantics](https://www.postgresql.org/docs/17/explicit-locking.html) and [row/statement triggers](https://www.postgresql.org/docs/17/sql-createtrigger.html). These mechanisms support the design; only the executed tests establish the limited fixture evidence reported here.
