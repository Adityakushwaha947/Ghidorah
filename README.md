# Ghidorah

A Mastra-backed, headless agent-harness proof of concept for Mettle. **Development fixture only; not production-ready.**

Mastra supplies the model/tool loop. Ghidorah owns request validation, allowed tool execution, budgets, run ownership, an action journal, evidence integrity checks and ordered frontend events. PostgreSQL persists product records and native workflow checkpoints in separate schemas.

Only `fixture://counter` and the synthetic `gidorah-fixture-v1` model are enabled in the run path. No live target, arbitrary shell tool, customer data or security finding is needed or supported. There is a CLI, not a complete terminal UI.

## Repository layout

This is a Bun workspace. Everything runs directly from TypeScript; there is no build step.

| Path | Package | Role |
| --- | --- | --- |
| `apps/ghidorah` | `@ghidorah/backend` | The backend runtime: journal, executor, Mastra adapter, CLI, tests, evals, scripts |
| `apps/frontend` | `@ghidorah/frontend` | Workspace slot for the Mettle frontend; see its README to move the existing repo in |
| `packages/contracts` | `@ghidorah/contracts` | Portable shared schemas, Zod only, with the drift manifest and generated JSON Schema |
| `packages/foundation` | `@ghidorah/foundation` | Errors, canonical digest, fixture contract, findings admission, reducer |
| `packages/model` | `@ghidorah/model` | Provider-neutral model gateway and the OpenRouter transport |

Bun loads a `.env` file in the working directory into `process.env` automatically. The database config still accepts only the explicit `GIDORAH_DATABASE_*` variables, and nothing reads `.env` in code, but be aware that variables you place there are visible to every script you run with Bun.

## Quick start

Requires Bun 1.4 or newer and a dedicated local PostgreSQL database. The optional Docker Compose service binds PostgreSQL to loopback only and uses an intentionally public development password. Never reuse that password or expose this fixture database remotely.

```sh
bun install --frozen-lockfile
docker compose up -d
export GIDORAH_DATABASE_PROFILE=local
export GIDORAH_DATABASE_URL='postgresql://gidorah:gidorah_dev_only@127.0.0.1:55432/gidorah'
bun run db:check
bun run db:init
bun run cli -- fixture
```

If PostgreSQL is already running locally, use a separate empty database and replace the example URL instead of starting Docker. The database role must be allowed to create the two fixture schemas. Initialization refuses to adopt existing unmarked schemas.

The public configuration accepts only an explicitly selected `local` profile and a PostgreSQL loopback URL. It never reads another application's environment file or falls back to `DATABASE_URL`. Query/fragment overrides and remote profiles are rejected. Local fixture connections do not use TLS; this is not a production database configuration.

## Verify

```sh
bun run typecheck
bun run build
bun run test:all
bun run test:comparison
bun run repro:native
```

Or run `bun run verify` for the complete local verification pipeline. After updating an existing dedicated fixture database, run `bun run db:init` to install the checkpoint-ownership migration before executing runs. No shared database is needed.

| Command | Scope |
| --- | --- |
| `bun run format:check` | Prettier style check; `bun run format` rewrites |
| `bun run test` | Contract, claim/receipt, configuration and runtime-integrity tests; no database |
| `bun run test:contracts` | Shared contract and model-gateway conformance with synthetic providers/journals |
| `bun run contracts:check` | Detect shared schema, validator and canonical-encoder drift |
| `bun run test:recovery` | Eight patch-installation and runtime regression tests, no database |
| `bun run test:integration` | Database integration tests, including real worker kills, native checkpoint fencing, failure handling and wall deadlines |
| `bun run eval` | 100 deterministic cases: 70 offline and 30 database-backed |
| `bun run eval:unit` | The 70 offline cases only |
| `bun run test:comparison` | Five event-normalization/report-helper tests, not a two-harness benchmark |
| `bun run repro:native` | Kill a native Mastra model-call process and recover from local PostgreSQL |
| `bun run acceptance:openrouter` | Live, capped OpenRouter run through the model gateway and Postgres dispatch journal; needs `OPENROUTER_API_KEY` in the environment |

The database-backed commands write isolated fixture records. Tests and fixtures must not run against shared or production databases. Generated evaluation/native reports are ignored by Git because they contain local paths and run metadata. See [public-copy validation](docs/validation.md) for the checked result summary.

## Recovery patch

The dependency is **`@mastra/core` 1.67.0 with a local patch**, not unmodified upstream Mastra. `bun install --frozen-lockfile` applies it through `postinstall`; `bun run patch:check` verifies the version and full hashes of both ESM/CommonJS bundles. Direct backend execution also verifies these hashes before allocating a run. If installation scripts were disabled, run `bun run patch:mastra` before execution.

The patch fixes the reproduced restart-input and model-output-pruning failures. Gidorah still rejects actions with uncertain outcomes rather than retrying them blindly. The patch is not an exactly-once guarantee for external services. See [the recovery fix](docs/recovery-fix.md).

## Code style

Prettier at 120 columns with the settings in `.prettierrc.json`; editors pick up `.editorconfig`. Markdown and `compose.yaml` are excluded. The contract manifest pins source hashes, so formatting changes under `packages/contracts/src/` or to the canonical encoder require a deliberate `packages/contracts/manifest.json` update; see [shared contracts](packages/contracts/README.md).

## Architecture and limits

- [Architecture](docs/architecture.md): layers, one run end to end, the uncertainty rule, ownership fencing, verification surface and production gates.
- [Frontend integration](docs/frontend.md): the event and control contract a UI or headless client consumes, reducer rules, exit codes, and what is not produced yet.
- [Recovery fix](docs/recovery-fix.md): root cause, exact dependency patch and maintenance requirements.
- [Production implementation plan](docs/production-plan.md): the reviewed Mettle ZIP, implemented hardening, remaining release gates and required handoffs.
- [Shared contracts](packages/contracts/README.md): frontend-safe types/validators and generated JSON Schemas; consumer acceptance is still required.
- [Model gateway](docs/model-gateway.md): finalized output, cancellation and accounting boundaries, the lease-fenced Postgres dispatch journal, the OpenRouter adapter and its live acceptance result. Not yet wired into the Mastra runtime.

This standalone public edition removes private infrastructure bindings, internal reports/PDFs and the separate comparison baseline. Its configuration tests and evaluation cases GID-064 through GID-068 cover the local-only policy instead. Do not claim that an earlier internal comparison certifies these changed bytes; rerun this edition's checks.

Native workflow checkpoints now enforce the current journal owner/epoch in PostgreSQL, with local failure/race tests. New claim/receipt schemas are preparation for real verification, not enabled scanners or a connected oracle. Production still requires authenticated tenant/target authorization, isolated execution, real-model accounting, integrated independent verification, durable approvals/findings, customer-data controls and sustained failure testing. **A passing counter fixture is not production approval.**
