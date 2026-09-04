# Server AGENTS.md

Server-specific documentation for the ElysiaJS API server (`apps/server`, `@internal/server`).

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
bun run compile            # bun build --compile host dev binary (dist/subshell-server; serves its own `mcp` subcommand)
bun run compile:release    # release pipeline — embedded SPA + SERVER triples (see "Standalone binary & CLI")
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
`profiles.route.ts`, …), aggregated in `src/api/routes.ts` (the off-the-tree
precedents are `auth-rate-limit.route.ts`, for route precedence, and the
root-mounted `install-script.ts`, because `/install.sh` is a dotted top-level
path the static SPA plugin would 404 — both mount directly in `server.ts`).
Most sit behind `src/api/auth-guard.ts`, which derives `user` (session cookie
or bearer key), provides `requireAdmin` (bearer keys are rejected on admin
surfaces), and defines the `status`-carrying error classes Elysia maps to HTTP
codes. `src/server.ts` composes the app; `src/index.ts` boots it (runs
migrations, then listens).

```
src/
├── api/            # Routes: flat *.route.ts (incl. downloads.route.ts — the subshell binaries) + per-resource dirs (subshells/, workspaces/, channels/, nodes/) + auth-guard.ts + routes.ts; install-script.ts renders root-mounted GET /install.sh
├── auth/           # Api-key store, DB handle, system user (better-auth config: ../auth.ts)
├── db/             # Kysely setup, migrations (static provider map), types/, repositories/
├── lib/            # context.ts (ApiContext + getRequestlessContext), api-error.ts (apiErrorBody)
├── plugins/        # auth.plugin.ts (better-auth handler mount), context.plugin.ts, error-handler.plugin.ts, static.plugin.ts
├── schema/         # Shared response schemas (error.type.ts: ApiErrorResponseSchema)
├── scripts/        # One-off dev tooling (e2e seed)
├── services/       # Business logic: subshell-manager, nodes/ (NodeLauncher seam), channels/, uploads, tokens, audit, notify, mcp-launch — tmux/ no longer lives here: TmuxRunner moved to `@internal/harnesses` (tmux-runner.ts) so the node client can reuse it
├── utils/          # Logger and small shared helpers
├── ws/             # Terminal attach WebSocket (short-lived single-use tokens; remote-node subshells relay through remote-subshell-ws.ts with the browser contract byte-identical to the local path)
└── test-preload.ts # Loaded by bunfig.toml before every test run
```

The Nodes plane adds two files outside the DB: `GET /api/downloads/node/*`
(`src/api/downloads.route.ts`) serves the prebuilt `subshell` binaries from
`NODE_ARTIFACTS_DIR` (`SUBSHELL_NODE_ARTIFACTS_DIR`, default
`<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` — populated by `bun run release:client`,
see root `AGENTS.md`), gated cookie-or-unconsumed-setup-key, never anonymous;
and `services/nodes/control-keys.ts` holds the command-signing keypair at
`<SUBSHELL_SERVER_DATA_DIR>/node-signing.json` (0600) — whoever holds it commands
every enrolled node.

Cross-subshell comms (`subshell mcp`) is registered per harness by the plugin
itself: `services/mcp-launch.ts:registerSubshellMcp` asks the plugin for its
dialect (claude: `--mcp-config` file; opencode: merged config layer +
`OPENCODE_CONFIG`; codex: per-invocation `-c mcp_servers.subshell.*` overrides —
no per-subshell file), while harnesses without a per-subshell format (hermes, pi)
write nothing and expose one-time registration steps via `GET
/api/profiles/harnesses/:id/schema` (rendered by the profile editor). See
`docs/architecture.md` §4.

Repositories (`src/db/repositories/`) are the primary Kysely writers; each
resource's row types are in `src/db/types/`. A few small writes bypass them
today (`authAttempts` in `auth-rate-limit.route.ts`, `userMeta` in `auth.ts`).
Services own cross-repo logic — route handlers stay thin. Routes MAY use
`contextPlugin` (`src/plugins/context.plugin.ts`), which gives handlers `ctx`
(a per-request `ApiContext`: `db`, `log`, `repos`, `services`). The subshells,
workspaces, and channels routes are converted to `ctx.services.*` and live in
per-resource directories under `src/api/`; other routes still instantiate
repositories directly with the shared `db`. Code outside requests (the ws
handlers) reaches the same graph via `getRequestlessContext()`
(`src/lib/context.ts`) — a singleton context whose log is the app logger
(no request id).

### Terminal attach diagnostics

A garbled live terminal is diagnosed from the journal first — two lines per
attach, both under `journalctl --user -u subshell-server.service | grep "ws attach"`:

- `geometry WxH … ua="…"` — the client's fitted size (`geometry MISSING` means
  a stale bundle that predates the feature) and which client sent it.
- `painted repainted=<bool> nudged=<bool> replay=<n>B dump=<dir|off>` — what
  the pane did before the capture. `repainted=false nudged=true` means the pane
  refused to repaint even for a forced SIGWINCH, so a bad replay is the pane's
  own state; `repainted=true` means a freshly painted frame was shipped and
  anything still wrong is downstream of the capture.

`SUBSHELL_ATTACH_DEBUG=1` additionally dumps
`/tmp/subshell-attach-debug/<subshell>/<timestamp>/{pre-resize,replay}.txt` — the
grid as the viewer found it vs. the exact bytes sent. **Off by default: the
dumps are real screen contents, which can include secrets.**

Two invariants on that path are load-bearing and easy to regress:

- Capture text (`replay`, pane-poll deltas) goes through
  `ws/capture-text.ts` — `capture-pane -p` emits **bare LFs**, and a bare LF
  keeps the cursor's column, which staircases every row into scrollback where
  nothing ever repaints it. The live tail must NOT be normalized: those bare
  LFs are the app's own deliberate output.
- The attach streams **gap-free** from a join point sampled BEFORE the resize.
  A skipped byte desynchronizes a diff-rendering TUI permanently; a bounded
  overlap is idempotent.

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

## Standalone binary & CLI

`src/index.ts` is BOTH the boot entry and the `subshell-server` CLI entry:
`bun build --compile` of it yields a self-contained binary — no bun, no repo
checkout on the host, and the built SPA **embedded** (see below). The boot
contract is untouched: no subcommand, or a leading flag, IS the boot path,
so the svc.sh/systemd deployment behaves byte-identically (spec 2026-09-03).

### Subcommands (hand-rolled dispatch in `src/cli.ts`, no flag library)

| Command | |
| --- | --- |
| `version` | print `subshell-server <version>` and exit |
| `status` | "what WOULD this boot with" — config.env path/existence, layer-tagged settings, masked secret (never echoed), tmux presence, port liveness, service definition on disk; reads only, never boots |
| `init` | first run: config home (0700), `BETTER_AUTH_SECRET` bootstrap (file value > env adoption > fresh 32 random bytes base64url), then the configure flow |
| `configure` | (re)write config.env; interactive unless `--yes`; flags `--port --host --base-url --db-path --yes` |
| `service install` | write + enable/start the per-user service (refuses before any write without a config.env — run `init` first) |
| `service uninstall` | stop + remove the service definition (deliberately never gates on config/tmux — a stranded unit must always come down) |
| `mcp` | serve the pane-spawned stdio MCP server (the self rung of MCP resolution below); the one long-running command — spawned by harnesses, not typed by humans |

An unknown word exits 1 with usage. **Sync-exit design** (house style for
the quick commands, no longer the safety mechanism): a handled command
should run to completion and `process.exit` SYNCHRONOUSLY inside
`dispatchCli` — sync fs, `readSync(0, …)` prompts (not readline),
`Bun.spawnSync` for the service manager. `mcp` is deliberately the
exception: it is long-running by design and suspends in its stdio loop.
What makes ANY suspension safe is not the exit style but two tested
invariants: the entry graph is IO-free AT IMPORT (lazy `getAuth()` — no
module opens SQLite or binds a port merely by being evaluated, pinned by
the import-purity tests), and the `isCliEngaged()` boot gate in
`index.ts` — flipped synchronously at subcommand recognition — is what
keeps a suspended (or sync) command from booting the server underneath
it. (Historical: on bun 1.4.0, measured not spec, ANY await in the entry
prelude lets the rest of the entry graph and the boot body evaluate; the
littering that once made sync-exit load-bearing — `@/auth.js` building
better-auth, and opening its SQLite file, eagerly at import — is gone
with the lazy construction, so the boot gate now carries that load.)

### config.env (`src/config-env.ts`)

`~/.config/subshell-server/config.env` — home overridden by
`SUBSHELL_SERVER_CONFIG_DIR`; dir 0700, file 0600, written via temp +
rename. The boot entry's first-imported `cli-bootstrap.ts` applies it with
SETDEFAULT semantics BEFORE `constants.ts` runs dotenvx, so the precedence
is **process env > config.env > `.env` (dotenvx, when the CWD has one) >
built-in defaults**. `configure` owns four keys — `SERVER_PORT`, `HOST`,
`APP_BASE_URL`, `DATABASE_PATH` — and `init` persists the secret (an
existing value is never rotated). tmux preflight: `init`, `configure` and
`service install` refuse before any write when tmux is absent (the `local`
node launches every pane through it); escape hatch
`SUBSHELL_SERVER_SKIP_TMUX_CHECK=1`.

`service install` (`src/service.ts`) writes `subshell-server.service` under
`~/.config/systemd/user/` — **the same unit name `svc.sh` writes; one owner
per host** (see `docs/subshell-rollout.md`) — with `WorkingDirectory=` and
`EnvironmentFile=` pointed at the config home (systemd and the binary's own
loader read the same file, so they cannot disagree), the installing shell's
PATH baked (a Homebrew/Nix tmux would vanish under the manager's stock
PATH), and `StartLimitIntervalSec=0` (Restart=always must survive an
EADDRINUSE crash loop). macOS: launchd agent `dev.subshell.server` →
`~/Library/LaunchAgents/`, log `~/Library/Logs/subshell-server.log`.

### MCP entrypoint resolution

Every subshell create spawns `subshell mcp`; HOW it's found is the pure ladder
in `src/services/mcp-resolve.ts` (split out of `mcp-launch.ts` so the
side-effect-free CLI can import it — it touches no fs):
`SUBSHELL_MCP_COMMAND`/`_ARGS` override → SELF (the server binary IS the MCP
server: `<execPath> mcp` when compiled, `<execPath> <absolute entry> mcp`
under `bun run`/dist) → the `subshell` node agent on PATH (`subshell mcp` —
safety net for installs whose server predates the self rung) → throw with the
`SUBSHELL_MCP_COMMAND` hint. A deployment matching NONE of these 500s on
create — `subshell-server status` prints the resolved command and its rung
(`mcp entrypoint = … (via …)`, or `UNRESOLVED`) so the gap shows up before a
user hits it. (`subshell-server mcp` became possible once the entry graph was
IO-free at import — lazy `getAuth()`, purity-tested — so a long-running
subcommand can no longer drag the boot graph into side effects; the 1.3.x
companion-binary era that made a separate tiny entry necessary is retired.)

### Embedded SPA + release dance

`selectStaticPlugin` picks the static source at boot: an on-disk frontend
dist wins (dev + svc.sh stay byte-identical), else the SPA baked into the
binary by `scripts/embed-web.ts` (`src/generated/embedded-web.ts` — a
TRACKED stub keeps the unconditional import legal on a fresh clone;
embedded responses carry a strong `ETag`, the tell of memory mode), else
boot fails loudly. Caveat measured on bun 1.4.0: the compiled binary bakes
its BUILD-TIME source path into `import.meta.url`, so on the build machine
the repo's own `apps/frontend/dist` shadows the embedded copy — hide that
path (e.g. a bind-mount sandbox) before asserting embedded mode is live.

From the repo root:

```bash
bunx turbo build           # 1. apps/frontend/dist must exist (embed preflight)
bun run release:server     # 2. = apps/server compile:release (src/scripts/release.ts)
```

The pipeline embeds the SPA (the generator overwrites the stub; the stub is
restored with `git checkout` in a `finally` — embedded bytes are release
noise, never a commit), builds the three `SERVER_TARGETS` triples
(`linux-x64`, `linux-arm64`, `darwin-arm64` — deliberately no darwin-x64;
`@internal/subshell-protocol` `paths.ts`) — one binary per triple: the
SPA-embedded `subshell-server-<triple>`, which serves its own `mcp`
subcommand so a server-only host self-resolves its MCP entrypoint —
each with `--bytecode` (bun ≥
1.4.0 asserted; `SUBSHELL_SERVER_RELEASE_TRIPLES` scopes a subset for CI),
darwin targets are signed + notarized first when `SUBSHELL_RELEASE_SIGN_CMD`
is set (CI sets it to `scripts/macos-sign-notarize.sh` on mac-builder — see
root `AGENTS.md`; unset locally, so plain release runs skip the hook),
and publishes atomically (tmp + rename + `.sha256` sidecar) to
`SUBSHELL_SERVER_RELEASE_DIR`, default `<repo-root>/dist-server` — an
operator drop dir to scp/deploy, not a data-dir ladder like the client's
node artifacts. A failed target publishes NOTHING.

## Testing

`bun test` only (vitest was removed — its node worker cannot import
`bun:sqlite`). `bunfig.toml` preloads `src/test-preload.ts`, which sets
`SUBSHELL_TEST_MODE`; `src/constants.ts` turns that into a **per-process
temp-file database** (`$TMPDIR/subshell-test-<pid>-<uuid>.db`, unlinked on exit —
one path string per process, so the app's Kysely connection and better-auth's
handle share one DB, and concurrent `bun test` invocations cannot contend)
and a throwaway log directory. `NODE_ARTIFACTS_DIR` derives from that temp
data dir under the test env, which is how the download-route tests write
fixtures straight in. All test files within one invocation share
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
assumed from a developer's local `data/subshell.db`.

Separately, the repo-root `e2e/` suite drives this server as a real subprocess
(`bun src/index.ts` with `NODE_ENV=development` against a temp-file DB and a
stub `pi` harness on port 3199) — a full-stack check that is deliberately
outside `bun test`. It is launched by `bun run test:e2e`, never by `turbo test`.
