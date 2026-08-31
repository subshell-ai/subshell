# Increment 1 — Docs & CI Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the starter repo's documentation/CI housekeeping: a `CLAUDE.md`→`AGENTS.md` bridge at root and per-app, a factual refresh of mote's stale AGENTS.md files, and dependabot for GitHub Actions only.

**Architecture:** Docs-only increment. Root `AGENTS.md` is the single source of truth; every `CLAUDE.md` is a two-line `@AGENTS.md` import so Claude Code and other agents read the same text. Backend/frontend `AGENTS.md` files describe mote **as it exists today** (SQLite, `bun test`, no generators, no context plugin yet) — later increments update them again when they change reality.

**Tech Stack:** Markdown, YAML (GitHub config), existing lefthook/commitlint toolchain.

**Spec:** `docs/superpowers/specs/2026-08-29-starter-structure-adoption-design.md`, Increment 1.

## Global Constraints

- Bun only (`bun install`, `bun run`, `bunx`) — never npm/pnpm/yarn.
- Package versions pinned exactly; no new dependencies in this increment (markdown/YAML only).
- Commits use conventional types from `commitlint.config.js`: `feat fix docs chore style refactor ci test revert perf`.
- No dynamic `import()` anywhere (n/a here — no TS changes).
- Verification after the increment: `bun run verify-types && bun run lint:check && bun run test` must pass (nothing here should touch them, but the branch gate still applies).
- Facts to preserve verbatim in docs: pre-push runs `verify-types`, `lint:check`, `test` (in that order); API server default port **3080**; testing is **`bun test`** (vitest was removed — its node worker cannot import `bun:sqlite`); `bunfig.toml` preloads `src/test-preload.ts` which sets `MOTE_TEST_MODE` → in-memory shared SQLite DB.

## Known findings this plan incorporates (verified on 2026-08-29)

- Root `AGENTS.md` tree still names the project `bun-elysiajs-starter-turbo-monorepo/` and omits `packages/harnesses` and `packages/session-protocol`.
- Root `AGENTS.md` has TWO git-hooks sections; the trailing one is wrong (says pre-push runs full `lint`).
- Root `AGENTS.md` "Code Generation" section and `apps/backend/AGENTS.md` generator sections describe `turbo gen` generators — **Turborepo 2.x removed generators**; no generator config exists in mote. Fiction; delete.
- `apps/backend/AGENTS.md` advertises PGAdmin :5050 (mote is `bun:sqlite`), and describes Vitest + Testcontainers + Postgres, `src/test-utils/global-setup.ts`, `testFramework`, `generateTestFacets`, `test-user-id` headers, `contextPlugin`/`ctx.services` — **none of these exist in mote today**. Real test infra: `bun test` with `bunfig.toml` preload → in-memory SQLite; route tests import helpers from `src/api/__tests__/helpers/auth-tables.ts` (`setupAuthTables`, `authedRequest`, `signIn`, `deleteUserByEmailOrId`).
- `.claude/rules/*.md` auto-loads for Claude Code; keep them as-is (not duplicated into AGENTS.md).
- No `CLAUDE.md` exists anywhere in mote; starter's are just `@AGENTS.md` (bridge text goes in root only).
- Starter's `.github/dependabot.yml` comments encode the rationale (SHA-pinned actions need a robot; JS deps are syncpack's job). Adopt it.

---

### Task 1: Root docs bridge + AGENTS.md refresh

**Files:**
- Create: `CLAUDE.md` (repo root)
- Modify: `AGENTS.md` (tree block, delete "Code Generation" section, delete trailing duplicate "Git Hooks (Lefthook)" section)

**Interfaces:**
- Consumes: nothing.
- Produces: `CLAUDE.md` bridge convention that Tasks 3–4 reuse per-app.

- [ ] **Step 1: Create root `CLAUDE.md`** with exactly:

```markdown
@AGENTS.md

## Claude Code specifics

The import above pulls in `AGENTS.md`, which is the single source of truth. Keep
project documentation there, not here — this file exists only because Claude Code
reads `CLAUDE.md` rather than `AGENTS.md`, and other coding agents read
`AGENTS.md` directly.

**Per-app documentation loads on demand.** `apps/backend/CLAUDE.md` and
`apps/frontend/CLAUDE.md` import their own `AGENTS.md`, but nested files only
enter context once you read a file in that directory. If you are planning work in
an app before opening any of its files, read that app's `AGENTS.md` first.

**`.claude/rules/` also loads automatically**, covering code style, testing,
verification, dependencies, and the security posture. Where a rule and an app's
`AGENTS.md` disagree, the app's documentation is more specific and wins — and the
disagreement is a bug worth fixing rather than a choice to make silently.
```

- [ ] **Step 2: Fix the directory tree in `AGENTS.md`.** Replace the fenced tree block (currently starting with `bun-elysiajs-starter-turbo-monorepo/`) with:

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

- [ ] **Step 3: Delete the `## Code Generation` section** (the one containing `turbo gen` and the pointer to backend generators) — Turborepo 2.x has no generators and mote has no generator config.

- [ ] **Step 4: Fix the `## Build Dependencies` section.** Replace its numbered list and trailing paragraph with:

```markdown
1. `@internal/backend-errors` and `@internal/session-protocol` build first (no internal deps)
2. `@internal/backend` depends on backend-errors, session-protocol, and harnesses
3. `@internal/backend-client` depends on backend (imports the `App` type for Eden Treaty)
4. `apps/frontend` depends on backend-client and session-protocol

For development, `build:dev` tasks use `hash-runner` for incremental builds — only rebuilding when source inputs change.
```

- [ ] **Step 5: Delete the trailing duplicate `## Git Hooks (Lefthook)` section** at the end of the file (it contradicts the accurate `### Git hooks` section, which already states pre-push runs `verify-types`, `lint:check`, `test`).

- [ ] **Step 6: Sanity-read** the resulting `AGENTS.md` top to bottom: no leftover "starter" self-reference, no duplicate sections, `### Git hooks` remains earlier in the file.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: bridge CLAUDE.md to AGENTS.md and de-stale the root agent doc"
```

---

### Task 2: Dependabot for GitHub Actions

**Files:**
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (terminal config).

- [ ] **Step 1: Create `.github/dependabot.yml`** with exactly:

```yaml
version: 2

updates:
  # The actions in .github/workflows are pinned to commit SHAs, which cannot be
  # updated by hand in any sane way. Dependabot raises a PR when a new release
  # appears and rewrites both the SHA and its trailing version comment.
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
    commit-message:
      # Matches the type-enum in commitlint.config.js so the PR passes commit linting.
      prefix: ci
    groups:
      github-actions:
        patterns:
          - "*"

# Note: JS dependencies are deliberately not managed here. They are pinned exactly
# and updated together via `bun run syncpack:update`, which keeps versions in sync
# across the workspace — something per-package Dependabot PRs would fight with.
```

- [ ] **Step 2: Validate YAML** — Run: `bunx js-yaml .github/dependabot.yml` (or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/dependabot.yml'))"` if js-yaml unavailable). Expected: parses without error.

- [ ] **Step 3: Commit**

```bash
git add .github/dependabot.yml
git commit -m "ci: dependabot for github-actions only (JS deps belong to syncpack)"
```

---

### Task 3: Backend AGENTS.md rewrite + CLAUDE.md bridge

**Files:**
- Rewrite: `apps/backend/AGENTS.md` (currently ~341 lines of starter-fork fiction)
- Create: `apps/backend/CLAUDE.md`

**Interfaces:**
- Consumes: Task 1's bridge convention.
- Produces: accurate backend doc. Increment 3 of the spec will later add the `ctx.services`/context-plugin sections when that code exists.

- [ ] **Step 1: Replace `apps/backend/AGENTS.md` entirely** with:

```markdown
# Backend AGENTS.md

Backend-specific documentation for the ElysiaJS API server.

## URLs

- API server: http://localhost:3080 (`SERVER_PORT`/`HOST` env, see `src/constants.ts`)
- OpenAPI docs (Scalar): http://localhost:3080/docs
- Production single-port model: the same server serves the built SPA
  (`src/plugins/static.plugin.ts` serves `apps/frontend/dist`) — there is no
  separate web server.

## Commands

```bash
bun run dev                # Watch-mode dev server (bun --watch src/index.ts)
bun run build              # tsc -> dist/ (plain JS, what `turbo build` runs)
bun run compile            # bun build --compile binaries (backend + mote-mcp)
bun run prod               # Run ./dist/index.js
bun run test               # bun test src (see Testing below)
bun run verify-types       # tsc --noEmit
```

### Database Migrations

```bash
bun run db:migrate:create  # Scaffold a new migration (kysely-ctl under bunx --bun)
bun run db:migrate:latest  # Apply pending migrations
bun run db:migrate:undo    # Roll the last migration back
```

The database is SQLite via `bun:sqlite` (`DATABASE_PATH`, default under
`data/`) — there is no Postgres and no Docker for tests. Migrations live in
`src/db/migrations/` **and** must be registered in the provider map in
`src/db/migrate.ts`; the boot migrator reads the static map because dynamic
imports break `bun build --compile`. File name and map key must match.

## Architecture

Routes are flat resource modules in `src/api/` (`bookmarks.route.ts`,
`sessions.route.ts`, …), aggregated in `src/api/routes.ts`. Most sit behind
`src/api/auth-guard.ts`, which derives `user` (session cookie or bearer key),
provides `requireAdmin` (bearer keys are rejected on admin surfaces), and
defines the `status`-carrying error classes Elysia maps to HTTP codes.

```
src/
├── api/            # One Elysia instance per resource + auth-guard.ts + routes.ts
├── auth/           # better-auth wiring, api-key store, system user
├── db/             # Kysely setup, migrations (static provider map), types/, repositories/
├── mcp/            # The `mote mcp` stdio server (separate compiled binary)
├── plugins/        # auth.plugin.ts (better-auth handler mount), static.plugin.ts
├── services/       # Business logic: session-manager, tmux/, channels/, uploads, tokens
├── ws/             # Terminal attach WebSocket (short-lived single-use tokens)
└── test-preload.ts # Loaded by bunfig.toml before every test run
```

Repositories (`src/db/repositories/`) are the only Kysely writers; each
resource's row types are in `src/db/types/`. Services own cross-repo logic —
route handlers stay thin. There is no request-context/DI container today:
routes instantiate repositories directly with the shared `db`.

## Testing

`bun test` only (vitest was removed — its node worker cannot import
`bun:sqlite`). `bunfig.toml` preloads `src/test-preload.ts`, which sets
`MOTE_TEST_MODE`; `src/constants.ts` turns that into a **shared in-memory
database** (`file::memory:?cache=shared`, so the app's Kysely connection and
better-auth's handle see the same DB) and a throwaway log directory. Tests
never touch `data/`.

Route tests live in `__tests__/` next to the route and share
`src/api/__tests__/helpers/auth-tables.ts`:

- `setupAuthTables()` — runs the real app + better-auth migrations once per suite
- `signIn(email, password)` / `authedRequest(...)` — real session cookies
- `deleteUserByEmailOrId(...)` — per-test cleanup

Migrations must be applied by the code under test or the helper — never
assumed from a developer's local `data/mote.db`.
```

(Outer fences: the file itself contains one fenced bash block — keep nesting correct when writing it.)

- [ ] **Step 2: Cross-check every factual claim** in the new file against: `apps/backend/package.json` scripts, `src/constants.ts`, `bunfig.toml`, `src/api/__tests__/helpers/auth-tables.ts` exports, `src/plugins/` contents. Fix any mismatch (the file must describe reality, not this plan's prose).

- [ ] **Step 3: Create `apps/backend/CLAUDE.md`** with exactly:

```markdown
@AGENTS.md
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/AGENTS.md apps/backend/CLAUDE.md
git commit -m "docs(backend): rewrite agent doc to describe mote as it actually is"
```

---

### Task 4: Frontend AGENTS.md (new) + CLAUDE.md bridge

**Files:**
- Create: `apps/frontend/AGENTS.md`
- Create: `apps/frontend/CLAUDE.md`

**Interfaces:**
- Consumes: Task 1's bridge convention.
- Produces: accurate frontend doc. Increment 4 of the spec will later document the `src/api/` typed layer when it exists — this file states today's convention (helpers in `lib/api.ts`).

- [ ] **Step 1: Create `apps/frontend/AGENTS.md`** with exactly:

```markdown
# Frontend AGENTS.md

Frontend-specific documentation for the React app.

## URLs

- Dev server: http://localhost:5173 (Vite) — proxies `/api` and `/ws` to the
  backend at 127.0.0.1:3080 so cookies and WS auth just work on one origin.
- Production: the app is built to `dist/` and served by the backend itself.

## Commands

```bash
bun run dev                # Vite dev server
bun run build              # vite build -> dist/
bun run test               # bun test --pass-with-no-tests (unit tests, see Testing)
bun run verify-types       # tsc --noEmit
```

## Layout

```
src/
├── routes/           # TanStack Router file-based routes (workspaces_.$id.tsx = flat nesting)
├── components/       # App components; components/ui/ = shadcn-style primitives (radix + cva)
├── hooks/            # Data hooks wrapping TanStack Query (use-bookmarks.ts, use-session-data.ts, ...)
├── lib/              # Non-UI utilities: api.ts (fetch helpers), auth.ts (better-auth client),
│                     # query-client.ts, session-frames.ts, workspace-layout.ts, ...
└── types/            # Hand-written mirrors of API response shapes
```

Route files stay thin: URL state + handlers + composition; data logic goes in
`hooks/`, reusable UI in `components/`, shared types/constants in `lib/`.

## Talking to the backend

All network access goes through helpers — components never call `fetch` raw:

- JSON endpoints: `apiFetch<T>` / `apiPost<T>` from `src/lib/api.ts` (cookie
  credentials included; failures throw `ApiError` with a numeric `status`).
- Sign-in/session: the better-auth client in `src/lib/auth.ts`.
- Terminal attach: `src/lib/use-session-ws.ts` — a short-lived (30 s) single-use
  WS token minted over REST, then the `/ws` connection. Never put the session
  bearer token in a URL.
- Uploads/streaming: the fetch paths in `src/lib/session-uploads.ts` and
  `src/hooks/use-terminal-uploads.ts`.

## Testing

`bun test` (no jsdom/vitest) with `src/test-setup.ts` preloaded. Component and
lib tests live in `__tests__/` next to the code (`components/__tests__/`,
`lib/__tests__/`). Tests are pure-function and component-level; browser-level
end-to-end coverage lives in the repo-root `e2e/` workspace (Playwright).

## Terminal gotchas

Workspace panes hold live xterm.js terminals inside dockview panels. A dockview
panel remount disposes its terminal, closes the WS, and forces a history
replay — every panel must keep `renderer: 'always'`, and every `dockview-react`
upgrade must re-run the manual probe documented in the root `AGENTS.md`.
```

(Outer fences: the file itself contains one fenced bash block — keep nesting correct when writing it.)

- [ ] **Step 2: Cross-check claims** against `apps/frontend/vite.config.ts` (proxy ports), `apps/frontend/package.json` scripts, `src/test-setup.ts` existence, `src/lib/use-session-ws.ts` behavior. Fix mismatches.

- [ ] **Step 3: Create `apps/frontend/CLAUDE.md`** with exactly:

```markdown
@AGENTS.md
```

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/AGENTS.md apps/frontend/CLAUDE.md
git commit -m "docs(frontend): add agent doc and CLAUDE.md bridge"
```

---

### Task 5: Full verification gate

**Files:** none (verification only).

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: green gate for the increment.

- [ ] **Step 1:** Run `bun run verify-types` — expected: all packages pass.
- [ ] **Step 2:** Run `bun run lint:check` — expected: no diagnostics.
- [ ] **Step 3:** Run `bun run test` — expected: all suites pass (unchanged — no code touched).
- [ ] **Step 4:** If anything fails, it means a doc edit accidentally touched code or a pre-commit hook reformatted something; fix the cause, commit `docs: fix <what>`, re-run all three.
