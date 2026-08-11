# ai-microsandbox

AI SDK v5 harness sandbox adapter (`HarnessV1SandboxProvider`) backed by
[microsandbox](https://docs.microsandbox.dev).

## Stack
- `@ai-sdk/harness` + `microsandbox` as peer deps (consumer brings both)
- `@ai-sdk/provider-utils` as a real runtime dep (e.g. `extractLines`)
- tsup (ESM-only, `dts: true`) driven by `tsconfig.build.json`
- `bun test` for tests, path alias `#/*` → `./src/*`

## Dev
- `bun run build` — tsup build to `dist/`
- `bun test` — run tests
- `pnpm turbo run check` (from root) — type-check + lint

## Architecture
- `src/index.ts` — public entrypoint (placeholder, not yet implemented)
