# Public-copy validation

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

**Production approval: no.** Checkpoint fencing, sandboxing, authentication/tenant isolation, real-model accounting, trusted verification and operational acceptance remain separate release gates.
