# @ghidorah/frontend

Workspace slot for the Mettle frontend, with a portable `GhidorahClient` in `src/client.ts`. It starts authenticated fixture jobs, fetches snapshots, consumes committed SSE events and sends stop commands. It rejects missing/gapped/cross-run events, truncated streams, insecure remote endpoints and credential-bearing redirects. This is a transport client, not the real UI.

What is already true for whatever lands here:

- It depends on `@ghidorah/contracts` through the Bun workspace, so `import { EventSchema } from "@ghidorah/contracts"` resolves without a build step.
- `bun run frontend:check` from the repository root validates a sample committed event and prints the contract version.
- The integration rules a client must follow are in [docs/frontend.md](../../docs/frontend.md).
- Local API authentication/setup and the remaining product-access limits are in [docs/product-api.md](../../docs/product-api.md).

Before importing the existing frontend, coordinate its repository/branch and preserve this client and workspace dependency. This directory is already nonempty; a direct `git subtree add --prefix apps/frontend` cannot be used as-is. Import into a temporary prefix or use a reviewed history-preserving migration, then merge the renderer with this package. Do not overwrite the transport client or call the placeholder the finished UI.

Keep the renderer's frontend-only dependencies separate from the backend. The UI consumes `@ghidorah/contracts` and this client; it must not import Postgres or Mastra internals.
