# Scripts

Standalone build and release scripts for maintaining the program.

---

## Prerequisites

Before running any scripts, install dependencies:

```bash
pnpm install
```

This also runs the `preinstall` hook which creates `.local.env` with
`NX_PARALLEL` set to your CPU core count.

---

## How to Run

| Script type                     | Invocation                   |
| ------------------------------- | ---------------------------- |
| `.js` (CommonJS)                | `node scripts/<name>.js`     |
| `.mjs` (ESM/ECMAScript Modules) | `node scripts/<name>.mjs`    |
| `.ts` (TypeScript)              | `pnpm tsx scripts/<name>.ts` |

Scripts wired into `package.json` can also be called with `pnpm run <name>`.

---

## Build and Assets

- `download-duckdb-extensions.ts` -- downloads platform-specific DuckDB
  extensions listed in `duckdb-extensions.json`. Run via `pnpm run assets`.

- `dependency-report.mjs` -- generates `etc/Dependency Report.md` listing
  production dependencies accessible to extensions via Node.js integration
  (nodeIntegration). Run via `pnpm run assets`.

- `extensions-rolldown.mjs` -- shared Rolldown bundler helpers for bundling
  in-repo extensions. Keeps core Vortex packages (e.g., `@vortex/*`) external
  (not inlined into the bundle; resolved at runtime) and remaps native module
  imports to their runtime paths. Extension build configs import this module;
  do not run it directly.

- `create-env-file.mjs` -- writes `.local.env` with `NX_PARALLEL` set to the
  number of CPU cores. Runs automatically on `pnpm install`.

- `generate-query-types.ts` -- generates TypeScript interfaces from SQL query
  definitions in `src/queries/`. Run via `pnpm run generate:query-types`.

---

## TypeScript Editor Support

The `.ts` files in this directory are standalone Node scripts run via
`pnpm tsx`. They are not part of any program package. `config/typescript/node.json`
provides type checking for these scripts so the editor
resolves `node:*` imports.

Run `pnpm exec tsc -p config/typescript/node.json` to check these scripts and
shared configuration. DuckDB types resolve from the main workspace, matching
the query generator's runtime dependency lookup.

## Releases

`releases/` groups release staging, build cleanup and their tests. Run
`node scripts/releases/stage-linux-release.mjs` after packaging, and
`pnpm --filter @nyastra/releases test` to check retention behavior. GitHub cleanup
runs through `.github/workflows/cleanup-builds.yml`. See
[Linux packaging](../docs/packaging/linux.md) for its retention policy.
