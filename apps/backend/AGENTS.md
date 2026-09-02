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
bun run dev                # Watch-mode dev server (bun run --watch src/index.ts)
bun run build              # tsc + tsc-alias -> dist/ (plain JS, what `turbo build` runs)
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

Routes are flat resource modules in `src/api/` (`files.route.ts`,
`sessions.route.ts`, …), aggregated in `src/api/routes.ts` (the sole
exception is `auth-rate-limit.route.ts`, mounted directly in `server.ts`).
Most sit behind `src/api/auth-guard.ts`, which derives `user` (session cookie
or bearer key), provides `requireAdmin` (bearer keys are rejected on admin
surfaces), and defines the `status`-carrying error classes Elysia maps to HTTP
codes. `src/server.ts` composes the app; `src/index.ts` boots it (runs
migrations, then listens).

```
src/
├── api/            # Routes: flat *.route.ts + per-resource dirs (sessions/, workspaces/, channels/) + auth-guard.ts + routes.ts
├── auth/           # Api-key store, DB handle, system user (better-auth config: ../auth.ts)
├── db/             # Kysely setup, migrations (static provider map), types/, repositories/
├── lib/            # context.ts (ApiContext + getRequestlessContext), api-error.ts (apiErrorBody)
├── mcp/            # `mote-mcp` binary entrypoint only (main.ts) — the server implementation moved to `@internal/mcp-core` (shared with the agent's `mote-agent mcp`, per the TmuxRunner precedent)
├── plugins/        # auth.plugin.ts (better-auth handler mount), context.plugin.ts, error-handler.plugin.ts, static.plugin.ts
├── schema/         # Shared response schemas (error.type.ts: ApiErrorResponseSchema)
├── scripts/        # One-off dev tooling (e2e seed)
├── services/       # Business logic: session-manager, nodes/ (NodeLauncher seam), channels/, uploads, tokens, audit, notify, mcp-launch — tmux/ no longer lives here: TmuxRunner moved to `@internal/harnesses` (tmux-runner.ts) so the node agent can reuse it
├── utils/          # Logger and small shared helpers
├── ws/             # Terminal attach WebSocket (short-lived single-use tokens; agent-node rows relay through remote-session-ws.ts with the browser contract byte-identical to the local path)
└── test-preload.ts # Loaded by bunfig.toml before every test run
```

Cross-session comms (`mote mcp`) is registered per harness by the plugin
itself: `services/mcp-launch.ts:registerSessionMcp` asks the plugin for its
dialect (claude: `--mcp-config` file; opencode: merged config layer +
`OPENCODE_CONFIG`), while harnesses without a per-session format (hermes, pi)
write nothing and expose one-time registration steps via `GET
/api/profiles/harnesses/:id/schema` (rendered by the profile editor). See
`docs/architecture.md` §4.

Repositories (`src/db/repositories/`) are the primary Kysely writers; each
resource's row types are in `src/db/types/`. A few small writes bypass them
today (`authAttempts` in `auth-rate-limit.route.ts`, `userMeta` in `auth.ts`).
Services own cross-repo logic — route handlers stay thin. Routes MAY use
`contextPlugin` (`src/plugins/context.plugin.ts`), which gives handlers `ctx`
(a per-request `ApiContext`: `db`, `log`, `repos`, `services`). The sessions,
workspaces, and channels routes are converted to `ctx.services.*` and live in
per-resource directories under `src/api/`; other routes still instantiate
repositories directly with the shared `db`. Code outside requests (the ws
handlers) reaches the same graph via `getRequestlessContext()`
(`src/lib/context.ts`) — a singleton context whose log is the app logger
(no request id).

### Error contract

Every non-2xx response carries the structured body of
`ApiErrorResponseSchema` (`src/schema/error.type.ts`):
`{ errId, code, message, statusCode, reqId?, metadata? }` — `errId` is a nanoid;
`code` is a machine-readable `BackendErrorCodes` value (`@internal/backend-errors`).
Two paths produce it:

- A handler that **returns** `status(code, apiErrorBody({ code, message }))`
  (`src/lib/api-error.ts`) — used by `uploads.route.ts` for expected 4xx.
- A thrown error mapped by the global `errorHandlerPlugin`
  (`src/plugins/error-handler.plugin.ts`), mounted first in `createApp()`:
  validation failures → 400 `INPUT_VALIDATION_ERROR`; `.status`-carrying errors
  (auth-guard classes, the service-local `*Error` throws) keep their status with
  a `code` derived from it; anything else → 500 with a generic message (internals
  never leak; outside production the body adds `stack`/`causedBy`).

Most converted routes take the **throw** path, not the return path. `errId`
appears on the wire for every error, but only **logged** errors (5xx and
explicit `throwApiError`) also emit a server log line carrying it — expected 4xx
are `doNotLog` and are deliberately not written to the log. `reqId` is declared
in the schema but only populated once request-scoped logging attaches it.

## Testing

`bun test` only (vitest was removed — its node worker cannot import
`bun:sqlite`). `bunfig.toml` preloads `src/test-preload.ts`, which sets
`MOTE_TEST_MODE`; `src/constants.ts` turns that into a **per-process
temp-file database** (`$TMPDIR/mote-test-<pid>-<uuid>.db`, unlinked on exit —
one path string per process, so the app's Kysely connection and better-auth's
handle share one DB, and concurrent `bun test` invocations cannot contend)
and a throwaway log directory. All test files within one invocation share
that DB, so suites must not assume it starts empty. Tests never touch
`data/`. (It used to be the URI string `file::memory:?cache=shared`, but
Bun treats URI strings as file names — every suite was sharing one literal
CWD file.)

Route tests live in `__tests__/` next to the route and share
`src/api/__tests__/helpers/auth-tables.ts`:

- `setupAuthTables()` — runs the real app + better-auth migrations once per suite
- `signIn(email, password)` / `authedRequest(...)` — real session cookies
- `deleteUserByEmailOrId(...)` — per-test cleanup

Migrations must be applied by the code under test or the helper — never
assumed from a developer's local `data/mote.db`.

Separately, the repo-root `e2e/` suite drives this server as a real subprocess
(`bun src/index.ts` with `NODE_ENV=development` against a temp-file DB and a
stub `pi` harness on port 3199) — a full-stack check that is deliberately
outside `bun test`. It is launched by `bun run test:e2e`, never by `turbo test`.
