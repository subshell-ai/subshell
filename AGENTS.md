# AGENTS.md

This document describes how this project works and how to perform common operations.

## Project Overview

This is a **Bun-powered TypeScript monorepo** using Turborepo for orchestration. It contains an ElysiaJS API backend, a React frontend, and shared packages: a type-safe Eden Treaty client SDK, the session protocol, agent harness plugins, and backend error handling.

### Directory Structure

```
mote/
├── apps/
│   ├── backend/                    # ElysiaJS API server; also serves the built SPA in prod
│   └── frontend/                   # React frontend (Vite, TanStack Router, TanStack Query, Tailwind CSS)
├── packages/
│   ├── tsconfig/                   # Shared TypeScript configuration
│   ├── backend-errors/             # Error emission and handling for the backend
│   ├── backend-client/             # Type-safe client for the backend API via Eden Treaty
│   ├── session-protocol/           # Session contract shared by backend and frontend: WS frames, upload limits
│   └── harnesses/                  # Harness plugin interface and built-in agent harness plugins
├── turbo.json                      # Turbo task configuration
├── package.json                    # Root workspace definition
├── biome.json                      # Linting and formatting
└── lefthook.yml                    # Git hooks
```

### Technology Stack

- **Runtime**: Bun (>= 1.4.0)
- **Backend Framework**: ElysiaJS
- **Frontend**: React 19, Vite, TanStack Router, TanStack Query, Tailwind CSS
- **Database**: SQLite via `bun:sqlite` with Kysely (type-safe query builder); dialect from [`kysely-bun-sqlite-dialect`](https://www.npmjs.com/package/kysely-bun-sqlite-dialect)
- **Validation**: Elysia's `t` module (TypeBox-based, generates OpenAPI schemas)
- **Logging**: LogLayer + @loglayer/elysia (request-scoped logging)
- **API Docs**: @elysiajs/openapi (Scalar UI at /docs)
- **Client SDK**: Eden Treaty (type-safe, no code generation)
- **Testing**: `bun test` (vitest was removed — its node worker cannot import `bun:sqlite`)
- **Linting/Formatting**: Biome
- **Monorepo**: Turborepo + Bun workspaces

## Common Commands

### Development

```bash
bun run start              # Start dev mode with watch (turbo watch dev)
turbo watch dev            # Same as above
```

### Building

```bash
turbo build                # Build all packages
```

### Testing

```bash
bun run test               # Run tests across all packages
bun run test:e2e           # Playwright end-to-end suite (boots its own backend on :3199)
```

The e2e suite lives in `e2e/` and is NOT part of `bun run test` or the pre-push
hook — it needs a real tmux server and a one-time `bunx playwright install
chromium`. See `e2e/AGENTS.md`.

### Database

Migrations are driven by `kysely-ctl`, which must run under Bun's runtime (`bunx --bun`)
because the dialect imports `bun:sqlite`, which Node cannot resolve.

```bash
bun run db:migrate:latest  # Apply pending migrations
bun run db:migrate:create  # Scaffold a new migration file
bun run db:migrate:undo    # Roll the last migration back
```

A new migration must be **both** created in `apps/backend/src/db/migrations/` and registered
in the provider map in `apps/backend/src/db/migrate.ts` — the CLI scans the folder, but the
app's boot-time migrator reads the static map (a dynamic import would break
`bun build --compile`). The file name and the map key must match.

### Upgrading `dockview-react`

Workspace panes hold live terminals. dockview must **not** remount a panel's
content when panels are moved or split — a remount disposes the terminal, closes
its WebSocket and forces a full history replay.

This was verified at 8.2.0 and is not covered by any automated test. After any
`dockview-react` upgrade, re-run the probe by hand:

1. Open a workspace with two or more panes and open DevTools → Network → WS.
2. Drag a pane onto another pane's edge to split, and drag a tab between groups.
3. **No new `/ws` connection may appear, and no existing one may close.**

If one does, the upgrade is not safe: pin back to the last known-good version.
Every panel must also keep `renderer: 'always'` — that is what keeps the DOM
alive when a panel is hidden.

### Linting and Formatting

```bash
bun run lint               # Lint all packages, writing fixes
bun run lint:check         # Lint read-only — fails instead of fixing (what pre-push runs)
bun run verify-types       # Type check all packages

# Format specific files
biome check --write --unsafe src
```

### Git hooks

lefthook installs itself via the root `prepare` script, so `bun install` in a fresh clone
wires the hooks up. To resync by hand: `bunx lefthook install`.

`pre-commit` formats/lints staged files; `pre-push` runs `verify-types`, `lint:check`, `test`.

### Cleaning

```bash
bun run clean              # Remove node_modules, turbo cache, dist, .hashes.json
bun run clean:turbo        # Remove .turbo directories only
bun run clean:dist         # Remove dist directories only
```

## Build Dependencies

The Turbo pipeline ensures correct build order:

1. `@internal/backend-errors` and `@internal/session-protocol` build first (no internal deps)
2. `@internal/backend` depends on backend-errors, session-protocol, and harnesses
3. `@internal/backend-client` depends on backend (imports the `App` type for Eden Treaty)
4. `apps/frontend` depends on backend-client and session-protocol

For development, `build:dev` tasks use `hash-runner` for incremental builds — only rebuilding when source inputs change.

## Package Synchronization

Keep dependencies in sync across packages:

```bash
bun run syncpack:update    # Update all dependencies
bun run syncpack:format    # Format package.json files
bun run syncpack:lint      # Check for version mismatches
```
