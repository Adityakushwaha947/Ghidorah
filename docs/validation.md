# Validation

## Shared contracts and gateway foundation — 19 September 2026

`npm run verify` passes on the new source: **119 unit tests** (including 70 new contract/gateway tests), **8 recovery-patch tests**, **19 PostgreSQL integration tests**, **100 deterministic evaluations**, **5 report-helper tests**, native SIGKILL recovery, typecheck, build and contract fingerprint verification. The database is a new dedicated local test database; no ProVue staging writes, customer targets or paid provider calls were made.

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
