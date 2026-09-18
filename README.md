# Gidorah

A Mastra-backed, headless agent-harness proof of concept for Mettle. **Development fixture only; not production-ready.**

Mastra supplies the model/tool loop. Gidorah owns request validation, allowed tool execution, budgets, run ownership, an action journal, evidence integrity checks and ordered frontend events. PostgreSQL persists product records and native workflow checkpoints in separate schemas.

Only `fixture://counter` and the synthetic `gidorah-fixture-v1` model are enabled. No API key, live target, arbitrary shell tool, customer data or security finding is needed or supported. There is a CLI, not a complete terminal UI.

## Quick start

Requires Node.js 24 and a dedicated local PostgreSQL database. The optional Docker Compose service binds PostgreSQL to loopback only and uses an intentionally public development password. Never reuse that password or expose this fixture database remotely.

```sh
nvm use
npm ci
docker compose up -d
export GIDORAH_DATABASE_PROFILE=local
export GIDORAH_DATABASE_URL='postgresql://gidorah:gidorah_dev_only@127.0.0.1:55432/gidorah'
npm run db:check
npm run db:init
npm run cli -- fixture
```

If PostgreSQL is already running locally, use a separate empty database and replace the example URL instead of starting Docker. The database role must be allowed to create the two fixture schemas. Initialization refuses to adopt existing unmarked schemas.

The public configuration accepts only an explicitly selected `local` profile and a PostgreSQL loopback URL. It never reads another application's environment file or falls back to `DATABASE_URL`. Query/fragment overrides and remote profiles are rejected. Local fixture connections do not use TLS; this is not a production database configuration.

## Verify

```sh
npm run typecheck
npm run build
npm run test:all
npm run test:comparison
npm run repro:native
```

| Command | Scope |
| --- | --- |
| `npm test` | Nine unit tests, no database |
| `npm run test:recovery` | Eight patch-installation and runtime regression tests, no database |
| `npm run test:integration` | Ten local database integration tests, including real worker kills |
| `npm run eval` | 100 deterministic cases: 70 offline and 30 database-backed |
| `npm run eval:unit` | The 70 offline cases only |
| `npm run test:comparison` | Five event-normalization/report-helper tests, not a two-harness benchmark |
| `npm run repro:native` | Kill a native Mastra model-call process and recover from local PostgreSQL |

The database-backed commands write isolated fixture records. Tests and fixtures must not run against shared or production databases. Generated evaluation/native reports are ignored by Git because they contain local paths and run metadata. See [public-copy validation](docs/validation.md) for the checked result summary.

## Recovery patch

The dependency is **`@mastra/core` 1.67.0 with a local patch**, not unmodified upstream Mastra. `npm ci` applies it through `postinstall`; `npm run patch:check` verifies the version and full hashes of both ESM/CommonJS bundles. If installation scripts were disabled, run `npm run patch:mastra` before execution.

The patch fixes the reproduced restart-input and model-output-pruning failures. Gidorah still rejects actions with uncertain outcomes rather than retrying them blindly. The patch is not an exactly-once guarantee for external services. See [the recovery fix](docs/recovery-fix.md).

## Architecture and limits

- [Architecture](docs/architecture.md): module ownership, job flow, persistence and production gates.
- [Recovery fix](docs/recovery-fix.md): root cause, exact dependency patch and maintenance requirements.

This standalone public edition removes private infrastructure bindings, internal reports/PDFs and the separate comparison baseline. Its configuration tests and evaluation cases GID-064 through GID-068 cover the local-only policy instead. Do not claim that an earlier internal comparison certifies these changed bytes; rerun this edition's checks.

Production still requires authoritative checkpoint fencing, authenticated tenant/target authorization, isolated execution, real-model accounting, independent finding verification, dependable client transport and sustained failure testing. **A passing counter fixture is not production approval.**
