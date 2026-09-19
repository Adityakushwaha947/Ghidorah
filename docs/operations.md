# Operations and release gates

**No production deployment is approved.** This document distinguishes executable local drills from deployment work requiring real infrastructure and accountable owners.

## Executable logical backup/restore drill

`bun run ops:restore-drill` requires the normal explicit loopback database configuration, PostgreSQL client binaries on `PATH` (or `GIDORAH_PG_BIN`) and a local role allowed to create/drop databases. Run only against a dedicated development PostgreSQL server.

The script creates two uniquely named temporary databases. It initializes the fixture in the first, kills a gateway-backed worker after its committed counter result, creates a custom-format `pg_dump`, and restores it into the second. It compares canonical digests/counts of every table in both product and native checkpoint schemas before recovery. It then validates the restored checkpoint fence, recovers the interrupted run, and requires 48 charged tokens, one counter effect and only the two remaining synthetic provider requests. Finally it drops only databases it created, deletes the temporary dump, and writes a machine-readable report under `apps/ghidorah/comparison/results/`.

Failed restore, different records, duplicate effects, failed recovery or failed cleanup cause nonzero exit. No raw credentials, dump content or customer data are printed. This proves a small logical restore and recovery path, not point-in-time recovery, encrypted offsite retention, role/secret restoration, regional failover, production RPO/RTO, object-store consistency or scale.

## Mastra dependency maintenance

The runtime refuses unexpected versions/bundle hashes. The reviewed patch lives in `apps/ghidorah/scripts/mastra-recovery-patch.mjs`; its behavioral regressions cover ESM and CommonJS. See [root causes and exact hashes](recovery-fix.md).

Before release the team must name a primary and backup maintainer, choose an upstreamed release or an owned fork, and record the upstream issue/PR or fork revision. None has been invented or submitted on the team's behalf. The current local patch is a development control, not that ownership decision.

For an upgrade: inspect all three upstream fault paths; keep old/new artifacts immutable; run installation/tamper tests, native recovery, gateway process kills, stale checkpoint fencing, restore drill and the full suite. Remove the patch only when the equivalent behavior passes without it. Rollback must use a separately accepted artifact and an explicit persisted-state compatibility decision; never change hash guards or delete uncertain records just to make startup pass.

## Required deployment evidence

| Gate | Required evidence before release |
| --- | --- |
| Model operations | Approved route and finite live-test budget; exact tokenizer/reservation and USD accounting; real timeout/refusal/cancel/disconnect/reconciliation tests; no hidden helper calls |
| Broker isolation | Approved dedicated Linux sandbox, resource limits and enforced egress/DNS/IPv6/redirect policy; no host mounts/socket/control-plane credentials; browser crash/cleanup/escape tests |
| Independent verification | Authenticated Gyms endpoint and contract acceptance; forged/stale/cross-run/reset receipts rejected; model cannot issue a verdict |
| Evidence | Accepted encrypted/versioned object store, manifests, capture-time redaction, retention/deletion and DB/object reconciliation; failed capture is not clean coverage |
| Access | Real identity provider, tenant/engagement ACL, immutable action approvals, audit retention, TLS/rotation and least-privilege runtime/database roles |
| Sustained runtime | Representative payloads and 200+ actions, approximately two-hour soak, controlled concurrency, provider/broker/DB/storage outages and process kills; measured latency/error/resource bounds |
| Recovery | Backups of DB and evidence under the same recovery policy; encrypted offsite/PITR restore and role/secret recovery; measured RPO/RTO and incident/rollback drill |
| Monitoring | Owned dashboards/alerts for queue age, expired leases, unresolved dispatches/effects, usage reconciliation, evidence mismatch, cleanup residuals, verifier failures, access denials and DB/object health; page and acknowledge tests |
| Supply chain | License/provenance decision, dependency policy, accepted container digests, named Mastra patch/fork ownership and maintenance cadence |

Structured fixture errors and test logs are not a monitoring deployment. Unit tests are not sustained load evidence. No live browser/API tool or customer network route should be enabled until its broker and scope controls have been accepted.
