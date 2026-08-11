# ai-microsandbox

Single-library monorepo. `packages/ai-microsandbox` publishes the `ai-microsandbox`
npm package — an AI SDK v5 harness sandbox adapter (`HarnessV1SandboxProvider`)
backed by [microsandbox](https://docs.microsandbox.dev).

## Workspaces
- `packages/ai-microsandbox` — the only publishable package. See its own AGENTS.md.

## Stack
- pnpm (install/lockfile) + Bun (runtime, `bun test`) + Turborepo (`check` tasks)
- Biome (format + lint), tsup (build), Changesets (release)

## Commands
- `pnpm install`
- `pnpm turbo run check` — type-check + lint every workspace
- `pnpm format` — `biome check --write` at the root
- `bunx changeset` — start a release (required before publishing)
