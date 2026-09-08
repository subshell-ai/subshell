# Starter Structure Adoption — Design

**Date:** 2026-08-29
**Branch:** `chore/starter-structure-adoption`
**Reference repo:** `/home/theo/projects/bun-elysiajs-starter-turbo-monorepo` (shared ancestor; it has kept evolving since the fork)

## Goal

Adopt the structural improvements the starter has gained since mote forked from it, without regressing mote's own advances (read-only `lint:check` CI, SQLite stack, session/channel features). Four increments, ordered so a browser-level safety net exists before the two risky refactors.

## What we deliberately do NOT adopt

- **Postgres / Testcontainers / smtp4dev / email & password-reset flows** — mote is SQLite (`bun:sqlite`) and has no mail surface.
- **react-hook-form + zod form convention** — large subjective churn across every mote form; mote's manual forms with `*-form.ts` validators work and are tested.
- **The starter's CI lint step** — it runs the *writing* `bun run lint`; mote's read-only `lint:check` is strictly better. Keep ours.
- **Dependabot for JS dependencies** — versions are pinned exactly and moved together by syncpack; per-package PRs would fight it (starter agrees, says so in its config comments).

## Increment 1 — Docs and CI housekeeping

1. **Root `CLAUDE.md` bridge**: contains `@AGENTS.md` plus a short note that `AGENTS.md` is the single source of truth (the file exists only because Claude Code reads `CLAUDE.md`; other agents read `AGENTS.md`). Per-app bridges (`apps/backend/CLAUDE.md`, `apps/frontend/CLAUDE.md`) import their app's `AGENTS.md`, so nested docs load on demand.
2. **AGENTS.md refresh**:
   - Root: fix the directory tree that still names the project `bun-elysiajs-starter-turbo-monorepo/` and omits `packages/harnesses` and `packages/session-protocol`.
   - `apps/backend/AGENTS.md`: remove the PGAdmin :5050 line (SQLite-only); audit command claims (e.g. the `turbo gen` scaffolding section) against actual scripts and remove or fix stale ones.
   - `apps/frontend/AGENTS.md`: new — app layout (routes/hooks/components/ui/lib), `bun test` conventions, and the API-access convention (worded for the post-Increment-4 `src/api/` layer).
3. **`.github/dependabot.yml`**: `github-actions` ecosystem only, monthly, grouped, commit prefix `ci` (passes commitlint's type enum); comment explaining why JS deps are excluded.

## Increment 2 — e2e Playwright workspace

**Placement.** New top-level `e2e/` workspace: `package.json`, `playwright.config.ts`, `global-setup.ts`, `global-teardown.ts`, `stack.ts`, `ports.ts`, `AGENTS.md`/`CLAUDE.md`, `tests/`. Registered in root `workspaces`; scripts `test:e2e` / `test:e2e:install`; turbo tasks mirroring the starter (uncached, `dependsOn: ["^build"]`).

**Stack shape — single origin, no Docker.** Mote serves the built SPA from the backend (`staticPlugin`), so e2e needs exactly one spawned process:

- `globalSetup`: ensure `turbo build` output exists, then spawn the compiled backend **detached in its own process group** (teardown kills the tree — the starter learned that killing only the parent leaves the real server holding the port), with `SERVER_PORT` from `ports.ts` (dedicated, never 3080), a scratch `DATABASE_PATH` file, a scratch `SESSION_DATA_DIR`, and a fixed e2e `BETTER_AUTH_SECRET`.
- Readiness: poll unauthenticated `GET /api/setup/status` until OK (starter's `waitForUrl` pattern).
- No Testcontainers; SQLite is a temp file. Teardown removes the temp dirs and kills the stack.
- Runs identically locally and in CI; never touches a developer's `data/` or a running `turbo watch dev`.
- Global setup starts a **pristine** stack (no users) so the first-run wizard is testable; all fixtures after that are created over HTTP by the specs/helpers themselves, exercising the real API paths.

**Dummy harness — as actually implemented.** Profiles CANNOT carry an arbitrary launch command: the harness registry has exactly four agent binaries (claude-code/opencode/hermes/pi) and launches go through `env -i … <argv>` with no shell. So the e2e stack stubs the **`pi` binary** via the `PI_PATH` env override (the harness detector honors it): a committed `e2e/stub/pi` script that answers `--version` for detection and otherwise loops, printing tick lines into the real pane log. Sessions launch it through the genuine production spawn path (tmux + `env -i` + session bearer token), with no agent CLI, no keys, no network. Correction to the original design (2026-08-29): ubuntu runners do NOT reliably ship tmux — the CI job installs it via apt-get like the existing test job does.

**Specs (suite 1).** `workers: 1`, alphabetically ordered files — `01` runs the wizard and saves admin storage state; later specs reuse it:

1. `01-setup-wizard` — first-run wizard → admin account creation → login → logout.
2. `02-auth-guard` — unauthenticated visit redirects to login.
3. `03-bookmarks` — create, edit, star, delete (including the invalid-path 400 surfaced in the UI).
4. `04-profiles` — CRUD, including creating the "shell" profile through the UI form.
5. `05-workspaces` — create, add panes, layout persists across reload.
6. `06-session-lifecycle` — against real tmux: create from UI → card shows running → terminal pane shows echoed output → terminate → delete.

**Spec 7 — channel round-trip (API-level, not browser):** channels have **no frontend UI** (decryption lives on the harness side), so this runs in the e2e workspace as a Playwright test using request contexts only: create two real sessions, obtain each one's per-session bearer token (same mint path the harness's start command receives; fallback if extraction proves impractical from outside a harness: an admin-minted system API key), post ECDH-sealed from A, long-poll as B and decrypt with B's identity keypair, and assert a third non-member sees only opaque ciphertext.

**CI.** `e2e` job added to `.github/workflows/test.yml`, mirroring the starter's: SHA-pinned actions, browser cache keyed on `e2e/package.json`, `playwright-report` artifact on failure, and an explicit `apt-get install tmux` step (the runner assumption below proved wrong).

**Implementation deltas (2026-08-29, recorded at build time):**

- `02`: the frontend has **no auth redirect** — the spec asserts API 401s on `/api/{sessions,bookmarks,profiles,workspaces}` + login-page render instead of a nonexistent redirect.
- `03`: no star control exists on the bookmarks page (starring lives on working-dir fields elsewhere); invalid-path rejection is asserted as an API 400, which is where the real contract lives.
- `04`/`06`: no "shell" profile is possible (see dummy-harness correction above) — `04` exercises the pi-harness profile CRUD; `06` proves pane liveness via the `ws-token` POST + `/ws` upgrade + absent reconnecting pill + status chips, because xterm's WebGL canvas keeps terminal output out of the DOM (the "echoed output" assertion was not implementable and would have been false-green).
- `07`: session bearer tokens are **never** returned by REST (`POST /api/sessions` → `{id, tmuxSocket, promptDelivered}`), so the channel round-trip uses three distinct **user** principals with cookie sessions + registered identities, not sessions — the same seal/open crypto (`jose`, ECDH-ES+A256KW) the harness uses, decrypting an envelope that round-tripped through the server.
- CI: ubuntu runners did **not** have tmux preinstalled; the job installs it (matching the existing `test` job).

## Increment 3 — Backend shared error format + service injection

**Shared error body (all routes, one pass).** New `src/lib/api-error.ts`, adapted from the starter: `apiErrorBody({ code, message, metadataSafe? })` → `{ errId, code, message, statusCode, metadata? }`. `errId` ties responses to log lines; only explicitly-safe metadata reaches the body. Codes come from `@internal/backend-errors` (existing dependency, barely used — extend its code enum as needed). A global `onError` in `createApp()` maps:

- errors carrying `status` (today's `UnauthorizedError`, `ForbiddenError`, route-local classes, Elysia `HTTPError`) → structured body preserving code + status (status codes unchanged everywhere);
- validation errors → structured 400;
- unknown throws → 500 with a fresh `errId`, logged server-side, internals never included.

An `ApiErrorResponse` TypeBox model registered via a small `apiModels` plugin lets any route write `response: { 200: X, 401: "ApiErrorResponse", 404: "ApiErrorResponse" }`. Typed error variants are added as routes convert below and opportunistically otherwise.

**`ApiContext` + services registry.** New `src/lib/context.ts` (`ApiContext` wiring `db`, request `log`, repos, and a `services` map with cross-service resolution) + `src/plugins/context.plugin.ts` exposing `ctx`, plus `getRequestlessContext()` for non-request callers (MCP tools, ws code that currently hand-build repositories). `BaseService` (log/db/repos + `withServices`) mirrors the starter.

**Conversion scope — deliberately bounded.** The big three: `sessions.route.ts` (283 ln), `workspaces.route.ts` (290 ln), `channels.route.ts` (324 ln). Each converts to handlers calling `ctx.services.*` and moves into a per-resource directory (`api/sessions/<verb>-session.route.ts` + `index.ts`, same pattern as the starter's `api/notes/`), with typed response variants. Session business logic stays the single source of truth in `session-manager.service.ts` — `SessionsService` wraps/delegates, no parallel truth. All remaining routes keep repo-in-handler style but inherit the shared error format automatically (their local error classes extend the shared `ApiError`). No big-bang DI sweep; the rest converts when next touched.

**Tests.** Existing route tests keep their status-code expectations; body-shape assertions gain `errId`/`code`. New tests: `apiErrorBody`, `onError` branches (validation / status-error / unknown throw), converted routes via existing route-test helpers.

## Increment 4 — Frontend typed API layer over Eden Treaty

Mote ships `@internal/backend-client` but the frontend never imports it — 33 call sites use untyped `apiFetch<T>` against hand-maintained mirrors in `src/types/`, which can drift from the backend silently.

**`src/lib/api.ts` gains:**

- `export const api = createBackendClient(...)` — singleton treaty client with a **relative base URL** (`""`). Same-origin in prod, vite-proxied in dev; an absolute `VITE_API_URL` default would break both. Fetch config adds `credentials: "include"`.
- `unwrap({ data, error })` → returns `data` or throws `BackendRequestError` (message from body, plus `status`, `code`, `errId` parsed from Increment 3's structured error body) so TanStack Query sees rejections and callers can branch on `code`.
- `apiFetch`/`apiPost`/`ApiError` **remain** for what treaty cannot carry: multipart uploads (`session-uploads.ts`, `use-terminal-uploads.ts`), WS attach token + socket (`use-session-ws.ts`), live/session-frame streaming (`useLiveSessions.ts`, `session-frames.ts`), and better-auth's own client (login flow).

**`src/api/<resource>.ts` modules** (bookmarks, profiles, sessions, workspaces, settings, users, system-keys, audit, identities, meta, setup, live): thin endpoint functions wrapping `unwrap(api.…)` plus query-key factories / `queryOptions` where a hook exists. Convention documented in `apps/frontend/AGENTS.md`: components and hooks import from `src/api/*`, never from `@internal/backend-client` directly.

**Hooks rewire** to the `src/api` functions; `src/types/*.ts` responses become derived types (`Awaited<ReturnType<typeof listBookmarks>>`) or are deleted when fully redundant. Request-side types come from treaty inference.

**Verification:** full unit suite + the Increment-2 e2e suite re-run green after this increment — that's the payoff for ordering e2e first.

### Increment 4 — STATUS: DEFERRED pending an Eden type-chain fix (2026-08-29)

A pre-flight type spike (predict the "Risks" bullet above) was run before touching
any of the 33 call sites: a throwaway `treaty<App>` probe compiled under the
frontend's `tsc`. It **failed** — `api.api.sessions` resolved against a union
including Eden's `"Please install Elysia before using Eden"` guard, and where
route structure did surface, request bodies were typed `unknown`. That means
`treaty<App>` inference across the `@internal/backend → @internal/backend-client`
dist/workspace boundary is degraded in this repo, so the migration's premise
("end-to-end typed client") does not currently hold.

Per the spec's own escape hatch — *"fall back per-module to typed `apiFetch`
rather than blocking"* — applied everywhere that fallback means **keeping the
existing `apiFetch<T>` + `src/types/` layer**, which already works and (after
Increment 3) already parses the structured error body. Rewriting 33 call sites
to a `body: unknown` / guarded-union client would be a net loss, so Increment 4
is **not performed** in this branch.

What unblocks it (a separate, investigation-first task): make `App` propagate as
a fully-resolved Elysia type to the frontend (single hoisted `elysia`, backend
dist emits the real `createApp` return type, Eden sees the same Elysia module
instance). Confirm with a probe that `api.api.*.$get()` yields typed `data`/`error`
with no guard union **before** migrating any call site. Increments 1–3 are
independent of this and are complete.

## Execution order and gates

1 → 2 → 3 → 4, each gate: `bun run verify-types && bun run lint:check && bun run test` clean; from Increment 2 onward, `bun run test:e2e` as well. Commits per increment (more granular within 3–4).

## Risks

- **treaty + Elysia plugin waterfall**: mote's routes are heavily `use()`-wrapped; if treaty type inference degrades (e.g. `any` errors), fall back per-module to typed `apiFetch` (still a win over untyped mirrors) rather than blocking the increment.
- **tmux in CI**: ubuntu runners include it, but pane-content assertions get a short retry/poll budget to absorb scheduling jitter.
- **Error-body shape change** is technically API-visible: the MCP api-client and any scripts parsing error bodies get checked in Increment 3 (they read `message`, which is preserved).
