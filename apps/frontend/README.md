# @ghidorah/frontend

Workspace slot for the Mettle frontend. The frontend team's existing repository moves into this directory; nothing here is the real UI.

What is already true for whatever lands here:

- It depends on `@ghidorah/contracts` through the Bun workspace, so `import { EventSchema } from "@ghidorah/contracts"` resolves without a build step.
- `bun run frontend:check` from the repository root validates a sample committed event and prints the contract version.
- The integration rules a client must follow are in [docs/frontend.md](../../docs/frontend.md).

To move the frontend in with history preserved:

```sh
git subtree add --prefix apps/frontend <frontend-repo-url> <branch>
```

Then merge this package's `dependencies` into the imported `package.json` and delete `src/check.ts`.
