# Authenticated fixture API and frontend client

Status: implemented and locally testable for `fixture://counter` only. This is not a customer API release. The executable server deliberately uses the synthetic model; importing `FixtureApi` can inject an explicitly approved counter model profile, but cannot enable external targets.

## Implemented path

`apps/frontend/src/client.ts` → HTTP/SSE → `apps/ghidorah/src/api/service.ts` → authority-bound `GidorahBackend` → Mastra/gateway/fixture executor → PostgreSQL committed events.

The API owns background execution independently of the HTTP response. Closing a frontend connection cancels its subscription, not the run. A second API instance can poll the same committed journal without owning the worker. Stopping is an explicit authorized command persisted in the journal and observed by the worker heartbeat.

## Authentication and ownership

`tokenAuthenticator` accepts SHA-256 token digests and server-owned principals. Bearer tokens must be 43–256 base64url characters; use cryptographically random deployment credentials, not sample strings. Principals contain `tenantId`, `actorId`, `engagementId`, `policyRevision`, an expiry in Unix milliseconds and permissions selected from `run:create`, `run:read`, `run:control`.

The service never trusts tenant/actor/policy headers or model-generated authority. It stores the authenticated authority atomically with the run. Reads, streams, controls and artifacts require the same authority; another tenant gets the same 404 as an unknown run. Legacy unscoped runs are unavailable through the API. An injected authenticator can perform central identity checks; the bundled static-token configuration is not SSO, a revocation service, customer authorization or an audit control plane.

This is application-layer isolation between authenticated API clients, not PostgreSQL RLS or protection from trusted local code/DB administrators. The in-process backend remains privileged. Use separate least-privilege database roles before deployment; do not give customers database or backend-process access.

## Routes

| Request | Permission | Result |
| --- | --- | --- |
| `POST /v1/runs` | `run:create` | Body `{ target, config }`; UUID `Idempotency-Key` required; 202 for a newly started run, 200 for an existing matching request |
| `GET /v1/runs/:runId` | `run:read` | Committed snapshot |
| `GET /v1/runs/:runId/events` | `run:read` | SSE: authoritative snapshot followed by ordered committed events |
| `GET /v1/runs/:runId/artifacts?ref=sha256:…` | `run:read` | Digest-checked fixture artifact |
| `POST /v1/runs/:runId/control` | `run:control` | `{ contractVersion: "1.0.0", type: "stop" }`; 202 acknowledgement |

Reusing an idempotency key with different input returns 409. A unique run ID prevents duplicate allocation across processes; the current startup coordination/capacity limits are process-local, not a distributed queue or globally enforced concurrency quota. An API crash does not automatically schedule recovery. Recovery is a trusted in-process/CLI operation, not a remote endpoint yet.

SSE carries `event: record` with the shared `Event` schema. A subscription failure is `event: transport.error`, never a fabricated `run.finished`. Reconnect with the same events URL to receive a fresh snapshot; no `Last-Event-ID` replay contract is advertised. The client validates event versions/run IDs and rejects sequence gaps or EOF before a terminal record. Token expiry/authority are rechecked while polling; revocation requires the configured authenticator to reject that token.

## Local startup

Use a dedicated local database. Set `GIDORAH_DATABASE_PROFILE=local` and `GIDORAH_DATABASE_URL` as in the root README. Provision `GIDORAH_API_TOKENS_JSON` through local secure configuration as an array of `{ "tokenSha256": "<64 lowercase hex characters>", "principal": { ... } }`; never commit the raw token. The terminal client's token callback reads its own secure credential source. Do not paste credentials into chat.

```sh
bun run db:init
bun run api:fixture
```

The server binds **127.0.0.1:4317**, or `GIDORAH_API_PORT`, and has no anonymous/default key. It rejects browser `Origin` requests: terminal/headless clients are supported, browser CORS is deliberately not enabled. New JSON requests are bounded to 64 KiB and 10 seconds; the server caps connections, active runs and observers. These are resource guards, not a benchmark or complete abuse-control layer. Do not expose it by changing a reverse-proxy configuration and calling it production-ready.

`GhidorahClient` supplies asynchronous `start`, `snapshot`, `events` and `stop`. It imports only shared portable contracts, never Mastra/Postgres. It is not the synchronous in-process `AgentApi`. The existing frontend renderer still needs to be brought into `apps/frontend` and connected; no replacement terminal UI was invented here.

## Tests and remaining work

`test/integration/api.test.ts` covers idempotency/conflict, cross-tenant denial on all resource routes, permission checks, forged authority/oversized body/origin rejection, frontend disconnect without worker cancellation, a separate observer instance, and an actual loopback child server driven by the frontend client. All targets/providers are synthetic.

Still missing: SSO/session lifecycle, durable read/control audit, deployment TLS/rate limits, database role isolation, distributed scheduling/quotas, remote recovery, action-bound approvals, human reviews, finding/report routes, the actual frontend, and customer-scope authorization. Tests of a counter and static tokens are not customer tenant-isolation certification.
