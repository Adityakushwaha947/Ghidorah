# Validation

## Runtime, fixture API and restore hardening — 19 September 2026

`bun run verify` and `bun run ops:restore-drill` pass on the tested working tree: **150 unit tests, 10 recovery-patch tests, 38 PostgreSQL integration tests, 100 deterministic evaluations and 5 report-helper tests**, plus native SIGKILL recovery, formatting, typecheck and contract drift checks. Build and the frontend contract smoke check passed separately. The [machine-readable summary](runtime-api-validation.json) records the observed commit plus uncommitted changes, source fingerprints and raw local report paths. This is developer-observed evidence, not independent attestation or release approval.

New coverage includes the actual loopback HTTP server and portable client, API authority/permission checks on snapshots/events/controls/artifacts, idempotent start, disconnect without cancelling background work, provider-stream bounds/redirect denial, stopped-run usage settlement, nondecreasing usage, trusted overage reconciliation, and real process kills in the gateway-backed Mastra loop. The latter exposed and fixed missing-tool rehydration in the pinned runtime; all four patched bundle hashes are enforced. No replay digest check was relaxed.

The logical restore drill created two fresh databases, backed up a killed gateway-backed fixture, restored **52 tables/14 rows**, compared exact canonical content digests, verified the checkpoint fence and recovered with **one counter effect, 48 charged test tokens and no repeated committed provider call**. The temporary databases were dropped and the isolated PostgreSQL server stopped. This is not production RPO/RTO, object-storage or offsite/PITR certification.

All provider responses in this validation were synthetic. No paid calls, ProVue database writes or customer targets were used. The executable server still admits only `fixture://counter`. USD accounting, sandboxed real tools, connected Gyms/evidence/reports, customer identity/approvals/full UI, monitoring, long load/failure tests and named dependency maintenance ownership remain open. See [API scope](product-api.md), [operations](operations.md) and [the production gates](production-plan.md). **Production approval: no.**

## Shared contracts and gateway foundation — 19 September 2026

`npm run verify` passes on the final source: **120 unit tests** (including 71 new contract/gateway tests), **8 recovery-patch tests**, **19 PostgreSQL integration tests**, **100 deterministic evaluations**, **5 report-helper tests**, native SIGKILL recovery, formatting, typecheck, build and contract fingerprint verification. Verification was repeated after the concurrent formatting/module-rename update and the final malformed-reservation guard. The database is a dedicated local test database; no ProVue staging writes, customer targets or paid provider calls were made. The temporary database server was stopped afterward.

The [machine-readable summary](contracts-validation.json) records the observed source commit, execution/contract hashes and raw local report paths. Gateway tests use synthetic normalized clients and a test-only journal. They do not prove actual OpenAI/OpenRouter transport behavior, durable billing reconciliation, real-provider recovery or sandbox isolation. Shared schemas are a consumer acceptance candidate, not a production deployment. See [the model boundary and remaining work](model-gateway.md).

Historical summaries below apply to their recorded source versions, not automatically to this implementation. No PDF was regenerated.

## Foundation hardening — 19 September 2026

`npm run verify` passed on the completed working tree with Node.js 24.21.0 and a dedicated temporary PostgreSQL 17.10 instance. No shared database, customer data, live target or paid model was used. The [machine-readable hardening summary](hardening-validation.json) identifies the tested source, suite and lock hashes. This is developer-observed local evidence, not independent attestation or production approval.

| Check | Result |
| --- | --- |
| Typecheck and build | Pass |
| Unit/claim/receipt/runtime-integrity tests | 49/49 |
| Recovery-patch tests | 8/8 |
| PostgreSQL integration tests | 19/19 |
| Deterministic evaluations | 100/100; unchanged during evaluation; zero failures, errors or missing cases |
| Event/report helper tests | 5/5 |
| Native SIGKILL and fenced recovery | Pass |
| Compiled CLI fixture | Completed |
| `npm audit --omit=dev` | Zero reported runtime advisories on this date; not a security certification |
| GitHub Actions workflow | Added and YAML syntax checked; not pushed or run remotely |

New database tests cover unowned/cross-run writes, three stale native write APIs, transaction ordering against lease takeover, terminal preservation, deletion/truncation denial, missing/modified guard rejection, wall-time cancellation, mandatory-write failure and an active old runtime losing ownership. They do not replace a two-process pause/resume takeover test, production role review, backup/restore, or endurance acceptance. Finding tests use synthetic evidence and authority resolvers; no real vulnerability is confirmed. See the [requirements and remaining gates](production-plan.md).

Raw local evidence: `tmp/hardening-verify.log`, `evals/results/2026-09-19T06-09-37-334Z-ec0b1d84-12dd-4f3a-95fd-7fbae55d2558.json`, and `comparison/results/native-recovery-e31f43b7-3bd4-42f2-9fd3-d3f59c15f716.json`. These generated files remain ignored by Git. The earlier validation below is retained as history and does not certify the changed code.

## Public-copy baseline — 18 September 2026

Validated locally on 2026-09-18 with Node.js 24.21.0 and a dedicated temporary PostgreSQL 17.10 instance. No shared database, customer target or paid provider was used. These results apply to the standalone local-only edition, not a deployment or an unchanged copy of the private comparison project.

| Check | Result |
| --- | --- |
| Clean `npm ci` and automatic pinned patch installation | Pass |
| Typecheck and build | Pass |
| Unit tests | 9/9 |
| Recovery-patch regression tests | 8/8 |
| Database integration tests | 10/10 |
| Event/report helper tests | 5/5 |
| Deterministic evaluations | 100/100; zero failures, errors, skipped cases or runner errors |
| Native SIGKILL and recovery | Pass |
| CLI counter fixture | Completed |
| Docker Compose configuration | Valid; database execution tested with native PostgreSQL, not this Docker image |

The integrated recovery case exercises three safe commit boundaries; the separate uncertain-dispatch/effect case still blocks blind recovery. Raw generated reports are retained locally and ignored by Git. The [machine-readable summary](validation.json) preserves the evaluation source/suite/lock fingerprints and installed patch hashes without local filesystem paths or private infrastructure metadata. This is a developer-observed summary, not signed independent attestation.

The five configuration evaluations GID-064 through GID-068 were explicitly adapted to the public local-only database policy. The recovery and uncertain-action assertions were not relaxed. Reproduce with the commands in the root README; further source changes require a new run.

**Production approval: no.** The later checkpoint hardening does not close sandboxing, engagement/target authorization, real-model accounting, integrated trusted verification, customer-data or operational acceptance gates.
