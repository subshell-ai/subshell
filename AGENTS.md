# AGENTS.md

This document describes how this project works and how to perform common operations.

## Project Overview

This is a **Bun-powered TypeScript monorepo** using Turborepo for orchestration. It contains an ElysiaJS API server, a React frontend, a node client daemon (`subshell`), and shared packages: a type-safe Eden Treaty client SDK, the subshell protocol, agent harness plugins, a shared `subshell mcp` server, and backend error handling.

### Directory Structure

```
subshell/
├── apps/
│   ├── server/                     # ElysiaJS API server; also serves the built SPA in prod
│   ├── frontend/                   # React frontend (Vite, TanStack Router, TanStack Query, Tailwind CSS)
│   ├── mobile/                     # Native companion app (React Native + Expo; see apps/mobile/AGENTS.md)
│   └── client/                     # subshell — node daemon; enrolls and runs signed commands (see apps/client/AGENTS.md)
├── packages/
│   ├── tsconfig/                   # Shared TypeScript configuration
│   ├── backend-errors/             # Error emission and handling for the backend
│   ├── backend-client/             # Type-safe client for the backend API via Eden Treaty
│   ├── subshell-protocol/          # Subshell contract shared by backend and frontend: WS frames, upload limits
│   ├── harnesses/                  # Harness plugin interface and built-in agent harness plugins
│   └── mcp-core/                   # The `subshell mcp` server (tools, E2EE crypto, identity/pin stores) shared by backend and agent
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

A new migration must be **both** created in `apps/server/src/db/migrations/` and registered
in the provider map in `apps/server/src/db/migrate.ts` — the CLI scans the folder, but the
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

`pre-commit` formats/lints staged files; `pre-push` runs `verify-types` and `lint:check`
only — the test suite belongs to CI (`.github/workflows/test.yml`) so pushes stay fast.
Run `bun run test` yourself before pushing work you want green on the first try.

### Cleaning

```bash
bun run clean              # Remove node_modules, turbo cache, dist, .hashes.json
bun run clean:turbo        # Remove .turbo directories only
bun run clean:dist         # Remove dist directories only
```

### Publishing subshell binaries (Nodes)

The prebuilt `subshell` binaries served by `GET /api/downloads/node/*` (the
node enroll flow) are built separately from the app build. The release dance,
from the repo root:

```bash
bunx turbo build                          # 1. package dists the client binary bundles
bun run release:client                    # 2. compile:release — cross-build + atomic publish
systemctl --user restart subshell-server.service     # 3. the server serves the new files
```

- `release:client` runs `apps/client`'s `compile:release` (`src/scripts/release.ts`):
  the four served triples (`linux|darwin × x64|arm64`), each cross-built WITH
  `--bytecode` (uniform since spec 2026-09-03 §5) — `SUBSHELL_RELEASE_TRIPLES`
  scopes a subset (CI uses this); each digested and published as
  `subshell-<triple>` + a fresh `.sha256` sidecar via temp-file + `rename()`
  (the atomic swap the downloads route's mtime-keyed cache requires). See
  `apps/client/AGENTS.md` for the app itself.
- Publish destination: `SUBSHELL_NODE_ARTIFACTS_DIR`, else
  `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` — the same default the server resolves.
  From a plain shell none of those vars are set (the service gets them from its
  unit/`EnvironmentFile`), so the ladder silently publishes to
  `apps/client/data/node-artifacts` where the server never looks — pass
  `SUBSHELL_NODE_ARTIFACTS_DIR` explicitly when deploying from a terminal.
- Cross builds download their target's bun runtime on first use; every target
  ships `--bytecode` (risk #9 retired at bun 1.4.0 — spec 2026-09-03 §5; the
  pipeline refuses older bun). A failed target exits non-zero and publishes
  NOTHING — never a half set.
- `turbo build` wipes the compiled `apps/client/dist/subshell` dev binary;
  re-create it with `cd apps/client && bun run compile`.
- Separately, `bun run release:server` builds the **control-plane** binary
  (not a Nodes download artifact): the three `SERVER_TARGETS` triples
  (`linux-x64`, `linux-arm64`, `darwin-arm64`), each `--bytecode`, with the
  built SPA **embedded** so the binary serves the UI with no frontend dist
  on the host (an embed step overwrites — then `git checkout` restores —
  the tracked `embedded-web.ts` stub). Published atomically to
  `SUBSHELL_SERVER_RELEASE_DIR`, default `<repo-root>/dist-server` — a
  local drop dir to scp/deploy; there is no data-dir ladder here. See
  `apps/server/AGENTS.md` ("Standalone binary & CLI") for the CLI
  (`init`/`configure`/`status`/`service install|uninstall`) and config.env.

### GitHub Releases (CI — `.github/workflows/release.yml`)

The same two pipelines run sharded in CI and ship as **GitHub Releases**
under component-scoped tags: `server-vX.Y.Z` (3 binaries + `.sha256`) and
`client-vX.Y.Z` (4 + 4). Tagging/releasing is OWNED BY THE WORKFLOW — never
cut tags by hand.

- **Version bumps (changesets):** `bunx changeset` after user-visible
  changes to `apps/server`/`apps/client` → a version PR ("chore: release
  package(s)") maintained on every push to main; merging it bumps the app's
  `package.json` + CHANGELOG. Merging does NOT cut a release.
- **The cut is an explicit dispatch:**
  `gh workflow run release.yml -f app=both` (or `app=server|client`,
  optional `-f version=X.Y.Z`; blank = read `apps/<app>/package.json`).
  The plan job pushes the missing tag(s) FIRST, then one build shard per
  app×triple on the self-hosted fleet (linux on `[self-hosted, Linux,
  X64]` — linux-arm64 cross-built there, `file` magic check only, never
  exec'd; darwin on mac-builder `[self-hosted, macOS, ARM64]` — darwin-x64
  smoke under Rosetta). Native shards exec `version`; server shards also
  BOOT on a temp DB with `apps/frontend/dist` hidden (the embedded-SPA
  proof). Publish = softprops draft-with-assets → second invocation flips
  live; any build failure ⇒ no release.
- **Retry:** a mid-flight failure leaves a tag without a release —
  re-dispatching COMPLETES the half-cut. Re-cutting a PUBLISHED version
  requires deleting the release and its tag first.

## Build Dependencies

The Turbo pipeline ensures correct build order:

1. `@internal/backend-errors`, `@internal/subshell-protocol`, and `@internal/mcp-core` build first (no internal deps)
2. `@internal/server` (`apps/server`) depends on backend-errors, subshell-protocol, harnesses, and mcp-core
3. `@internal/backend-client` depends on server (imports the `App` type for Eden Treaty)
4. `apps/frontend` depends on backend-client and subshell-protocol
5. `@internal/client` (`apps/client`) depends on backend-errors, subshell-protocol, harnesses, and mcp-core — its compiled binary bundles those dists, which is why `turbo build` is a preflight for `release:client` (and the reverse hazard: the build wipes `apps/client/dist/subshell`)

For development, `build:dev` tasks use `hash-runner` for incremental builds — only rebuilding when source inputs change.

## Package Synchronization

Keep dependencies in sync across packages:

```bash
bun run syncpack:update    # Update all dependencies
bun run syncpack:format    # Format package.json files
bun run syncpack:lint      # Check for version mismatches
```
