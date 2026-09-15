# Server AGENTS.md

Server-specific documentation for the ElysiaJS API server (`apps/server/api`, `@internal/server`).

## URLs

- API server: http://localhost:3080 (`SERVER_PORT`/`HOST` env, see `src/constants.ts`)
- OpenAPI docs (Scalar): http://localhost:3080/docs
- Production single-port model: the same server serves the built SPA
  (`src/plugins/static.plugin.ts` serves `apps/server/web/dist`) — there is no
  separate web server.

## Commands

```bash
bun run dev                # Watch-mode dev server (bun run --watch src/index.ts)
bun run build              # tsc + tsc-alias -> dist/ (plain JS, what `turbo build` runs)
bun run compile            # bun build --compile host dev binary (dist/subshell-server; serves its own `mcp` subcommand)
bun run compile:release    # release pipeline — embedded SPA + SERVER triples (see "Standalone binary & CLI")
bun run prod               # Run ./dist/index.js
bun run test               # bun test --timeout 30000 src (see Testing below)
bun run verify-types       # tsc --noEmit
```

### Dev conveniences

Both scripts run from `apps/server/api` only — `bun run ./src/index.ts` and friends
fail from the repo root, where workspace resolution does not apply.

```bash
bun run scripts/set-admin-password.ts <email> <new-password>   # forgotten dev admin
bun run src/scripts/e2e-seed.ts create|token|ciphertext        # e2e fixtures
```

`set-admin-password.ts` opens `./data/subshell.db` **hard-coded** — it ignores
`DATABASE_PATH`, so it can only ever reach the dev database, never a deployed
one under `~/.config/subshell-server/`. For a real instance the recovery path is
`SUBSHELL_EMERGENCY_PASSWORD` (see `.claude/rules/security-context.md`).

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
`presets.route.ts`, …), aggregated in `src/api/routes.ts` (the off-the-tree
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
├── api/            # Routes: flat *.route.ts (incl. downloads.route.ts — the subshell binaries; admin-status.route.ts — the whole instance in one admin-only read; plugins.route.ts — /api/plugins, the instance plugin store, writes cookie-admin) + per-resource dirs (subshells/, workspaces/, channels/, nodes/) + auth-guard.ts + routes.ts; install-script.ts renders root-mounted GET /install.sh
├── auth/           # Api-key store, DB handle, system user (better-auth config: ../auth.ts)
├── db/             # Kysely setup, migrations (static provider map), types/, repositories/
├── lib/            # context.ts (ApiContext + getRequestlessContext), api-error.ts (apiErrorBody)
├── plugins/        # auth.plugin.ts (better-auth handler mount), context.plugin.ts, error-handler.plugin.ts, static.plugin.ts
├── schema/         # Shared response schemas (error.type.ts: ApiErrorResponseSchema)
├── scripts/        # e2e seed, embed-web.ts (SPA -> generated/embedded-web.ts), release.ts
├── services/       # Business logic: subshell-manager, nodes/ (NodeLauncher seam), channels/, uploads, tokens, audit, notify, mcp-launch — tmux/ no longer lives here: TmuxRunner moved to `@internal/pane-runtime` (tmux-runner.ts) so the node agent can reuse it
├── utils/          # Logger and small shared helpers
├── ws/             # Terminal attach WebSocket (short-lived single-use tokens; remote-node subshells relay through remote-subshell-ws.ts with the browser contract byte-identical to the local path)
└── test-preload.ts # Loaded by bunfig.toml before every test run
```

The Nodes plane adds two files outside the DB: `GET /api/downloads/node/*`
(`src/api/downloads.route.ts`) serves the prebuilt `subshell` binaries —
published as `subshell-node-cli-<triple>` + `.sha256` — from `NODE_ARTIFACTS_DIR`
(`SUBSHELL_NODE_ARTIFACTS_DIR`, default
`<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` — populated by `bun run release:node`,
see root `AGENTS.md`), gated cookie-or-unconsumed-setup-key, never anonymous.
A binary-only server install ships that dir EMPTY. That used to mean the
install one-liner 404ed until someone published; since 2026-09-12 the server
FETCHES a missing binary from the project's own `node-v*` GitHub release the
first time a machine asks for it (`services/node-release.ts`). Lazily, on the
download route's 404 branch — no warm-up, no admin button, no poll, so a plane
whose nodes are all one platform never spends a byte on the others. The bytes
stream THROUGH while being hashed against the release's `.sha256` (fetched
first); a mismatch errors the response mid-flight, so nothing unverified is
cached and the node's own digest check before `chmod +x` still decides.
`SUBSHELL_NODE_RELEASE_URL` configures it and EMPTY disables it — the
air-gapped configuration, and the default under `IS_TEST` so no suite reaches
the network by accident. A file on disk always wins over a fetch, and only
what this instance fetched (recorded in `<node-artifacts>/.fetched.json` with
its release tag) is ever superseded when a newer tag appears — a hand-published
binary has no entry and is never touched. Superseded platforms are DELETED
rather than refreshed: the file comes back when a machine of that platform next
enrolls, which is the same laziness the rest of the path keeps.

Three surfaces still report what is on disk, so the air-gapped case is visible
instead of being discovered: the published set (`lib/node-artifacts.ts:publishedNodeTargets`,
the same regular-non-empty-file rule the download routes 404 on) rides
`GET /api/settings/public → nodeArtifactTargets` for the dialog (beside
`nodeArtifactsAutoFetch`, which is what tells the dialog whether an absent
binary is a problem or a cache miss), prints as
`node artifacts = N/4 published` in `subshell-server status`, and the
rendered `install.sh` downloads to a temp path, inspects the HTTP code
(404 → publish guidance naming the GitHub Release asset; 401 → mint a fresh
key; network → says so), verifies the digest BEFORE the temp file may
`mv`-replace `$DEST`, and can therefore never clobber an installed agent on
a failed download;
and `services/nodes/control-keys.ts` holds the command-signing keypair at
`<SUBSHELL_SERVER_DATA_DIR>/node-signing.json` (0600) — whoever holds it commands
every enrolled node.

Plugins live on the control plane now (spec 2026-09-10): the per-node
`set-node-plugin` route, `plugin-sync.ts` and the signed `plugin_install` /
`plugin_uninstall` commands are GONE, and with them the `nodes.plugins_json`
mirror they left behind (migration 0026, which also creates the instance-level
`plugin_state` table). The instance door is `api/plugins.route.ts`
(`/api/plugins`: list for any authenticated actor; install / enable / impact /
uninstall are cookie-admin, since installing runs third-party code in the
process that holds the node signing keypair). A registry `spec` still installs
VERBATIM — malformed spec is a 400 before any fetch, a failed install a 409
carrying the pane-runtime message — and the URL fetched from is
`SUBSHELL_PLUGIN_REGISTRY_URL` (constants.ts, same SETDEFAULT ladder as every
other server setting; `subshell-server status` prints it as
`plugin registry = <url>`; the route's `setPluginsRegistryUrlForTests` seam is
test-only by construction). `<dataDir>/plugins/` is the one installed set:
"usable" is (instance installed ∧ `plugin_state.enabled` — absent row =
enabled) × (that node's detection found the binary), computed once in
`api/harness-utils.ts` for every node alike. And the plane RESOLVES the set:
`services/nodes/local-plugins.ts` points the pane-runtime registry overlay at
this store at boot and after every install and uninstall
(`refreshInstalledPlugins`), so `getHarness` answers for a registry-installed
plugin the moment the install returns (detect specs, preset validation, argv
— the whole launch path). Built-in ids always resolve to the compiled copy:
the seeded directories refresh silently, and a registry package claiming a
built-in id is warned about once and never loaded. That is also why
`plugins.route.ts` and `setup.route.ts` read `builtInHarnesses()` for their
offline-installable catalog region: once the overlay exists, the merged
`allHarnesses()` answers "what resolves", never "what can this build install".
The agent never refreshes an overlay: after Task 7 it holds no plugin concept
at all, so its built-in-only view is structural, not configured. The
anonymous setup route has NO spec field — built-in ids only, forever (spec
2026-09-09 §13).

Cross-subshell comms (`subshell mcp`) is registered per harness by the plugin
itself: `services/mcp-launch.ts:registerSubshellMcp` asks the plugin for its
dialect (claude: `--mcp-config` file; opencode: merged config layer +
`OPENCODE_CONFIG`; codex: per-invocation `-c mcp_servers.subshell.*` overrides —
no per-subshell file), while harnesses without a per-subshell format (hermes, pi)
write nothing and expose one-time registration steps via `GET
/api/presets/harnesses/:id/schema` (rendered by the preset editor). See
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

**Workspaces have a draft state** (spec 2026-09-14): `workspaces.draft` is 0/1 and
the per-user unique name index is PARTIAL (`WHERE draft = 0`), so an unsaved
workspace created by splitting a subshell may share a name freely. `GET /` hides
drafts; `?subshellId=` is the one read that returns them. `PUT /:id { draft: false }`
is the only transition, and removing a pane from a draft left with fewer than two
deletes the draft (`workspaceDeleted: true`). Migration `0029`'s `down` DELETES
drafts rather than renaming them — the pre-0029 schema cannot express one.

The pane's size with SEVERAL viewers attached is not decided here: the rule is
`shared-geometry.ts` in `@internal/subshell-protocol`, because the browser has
to EXPLAIN the same decision the server APPLIES. It picks the smallest
capacity among the narrowest non-empty **rung** — devices being rendered whose
viewer can type, else any device being rendered, else every attached device —
with a pin overriding all of it. A rung that holds nobody with a usable size is
skipped, so excluding a device can never shrink the pane below what the
remaining ones reported.

`ws/subshell-ws.ts` owns the state around it: the per-subshell viewer registry
(keyed by `viewerId`, NEVER by socket identity — Elysia hands `close` a
different wrapper than `open`) and the in-memory sizing policy, dropped with
the last viewer. `resetLiveViewersForTests()` clears ALL of that module's
per-subshell state together (viewers, policy, heartbeat stamps, pumps, applied
geometry) because tests reuse subshell ids and any one of those surviving a
case corrupts the next in a way that reads as a product bug.

**Both attach paths are the same shape**, and the remote one (`ws/remote-subshell-ws.ts`)
was brought to it late — before that it fitted the pane to whoever attached
last and ran its own `tail_start` per socket, which `NodeLauncher`'s contract
forbids ("callers MUST NOT overlap per-subshell pumps"). Both now:

1. subscribe to the shared pump (`ws/pane-stream.ts`) BEFORE reading the pane,
2. fit to `sharedGridFor()`, seed the geometry queue with what they applied,
3. capture, send the replay, then `open()` the subscription and broadcast presence.

Step 1 before step 3 is the join-point rule as a subscription. It also means a
refusal AFTER the subscription must tear it down explicitly, or a tail keeps
running for a viewer that was never admitted.

**The `geometry` frame carries a CONFIRMED grid on both paths.** `paneSize()`
is the single question — `LocalLauncher` reads tmux directly, `RemoteLauncher`
asks the node with the `pane_size` command — and it answers a
real grid or `null`, never a guess. `resize` is a request, not a guarantee: a
client that believes it holds a size the pane never took paints every later
frame onto the wrong rows.

This is why it matters that the answer is real. With several viewers the pane
is the MINIMUM of what they can show, so a client left to size itself renders
more rows than the pane holds, and a client taller than its pane does not
scroll when the pane does — putting every later relative-positioned frame a row
out, which is the exact corruption this whole subsystem exists to prevent.

`null` means "could not be read", and nothing is announced. Usually that is the
pane being gone; a wedged-but-connected node reaches the same answer, which is
why `RemoteLauncher.paneSize` logs the failure at debug rather than swallowing
it — otherwise geometry announcements for that pane would stop with nothing in
the journal. (An earlier revision had no size command and a node pane announced
the size it had been ASKED for. That asymmetry is gone; do not reintroduce it.)

**An agent is refused by TWO gates, in this order** (`node-ws-handler.ts`,
both closing 4406 with a reason the agent RELAYS to its own log):

1. **The version floor.** `MIN_AGENT_VERSION`
   (`@internal/subshell-protocol` `versions.ts`) is the operator-facing
   statement "this server needs subshell >= X". The reason names both the
   required and the found version. This is the gate an operator can act on,
   which is why it runs first — and it is bumped deliberately, on its own
   schedule, whenever a server needs newer agent BEHAVIOUR.
2. **The protocol, matched EXACTLY.** Any `protocolVersion` differing from
   `NODE_PROTOCOL_VERSION`, in either direction, is refused; the reason names
   both numbers. No compatibility window, no per-feature gating — the server
   and the agent ship together, so a mismatch is a deployment out of step
   rather than a node to be carried. Bump it whenever a frame changes,
   additive or not, and release both.

The identity is persisted BEFORE either gate, so a refused agent still shows
its version on the Nodes page. The node detail page chips "agent too old" /
"agent too new" for a protocol mismatch and "below minimum" for a floor
refusal; Settings → Status lists every enrolled agent under the floor in one
place, since a refused agent looks like an ordinary offline node everywhere
else.

The two gates are INDEPENDENT — raising the floor without a protocol bump is
the normal case — so never infer one from the other.

Neither gate touches geometry: `paneSize` answers the same way on a local and a
remote pane, so nothing downstream of the attach branches on where a pane runs.

### Terminal attach diagnostics

A garbled live terminal is diagnosed from the journal first — two lines per
attach, both under `journalctl --user -u subshell-server.service | grep "ws attach"`:

- `geometry WxH build=<id> ua="…"` — the client's fitted size (`geometry
  MISSING` means a stale bundle that predates the feature), **which bundle**
  is talking, and which client sent it. `build` is the frontend's own asset
  hash (`apps/server/web/src/lib/build-id.ts`): it CHANGES when the client
  reloads new code and stays the same when it does not, so "the PWA is still
  running pre-fix JavaScript" is visible instead of being mistaken for a
  server bug — static requests are not logged, so this is the only signal.
  `build=MISSING` is a bundle older than the field; `build=dev` is a dev
  server.
- `painted repainted=<bool> nudged=<bool> replay=<n>B dump=<dir|off>` — what
  the pane did before the capture.
  `repainted=false nudged=true` means the pane refused to repaint even for a
  forced SIGWINCH, so a bad replay is the pane's own state; `repainted=true`
  means a freshly painted frame was shipped and anything still wrong is
  downstream of the capture.

`SUBSHELL_ATTACH_DEBUG=1` additionally dumps
`/tmp/subshell-attach-debug/<subshell>/<timestamp>/{pre-resize,replay}.txt` — the
grid as the viewer found it vs. the exact bytes sent. **Off by default: the
dumps are real screen contents, which can include secrets.**

Three invariants on that path are load-bearing and easy to regress:

- Capture text (`replay`, pane-poll deltas) goes through
  `ws/capture-text.ts` — `capture-pane -p` emits **bare LFs**, and a bare LF
  keeps the cursor's column, which staircases every row into scrollback where
  nothing ever repaints it. The live tail must NOT be normalized: those bare
  LFs are the app's own deliberate output.
- The attach streams **gap-free**: a skipped byte desynchronizes a
  diff-rendering TUI permanently. The tail therefore joins at a PRE-RESIZE
  log offset, so the replayed capture and the first streamed bytes **overlap**.
  That overlap is not free: it is *not* idempotent for a relative-positioned
  renderer (Ink replays move the cursor up and rewrite, so re-applying
  pre-snapshot frames over a fresh capture can corrupt it), so this is
  deliberate damage control — a visible transient beats a permanent desync,
  and a skipped byte is permanent.
  A zero-overlap "quiet join" (`size → capture → cursor → size` until the log
  stops growing, then restore the pane's cursor with a CUP) was tried in
  `9190c2f` and **rolled back on 2026-09-04** as part of returning this path
  to its last known-working state. If it is attempted again, note what the
  rollback preserved: the replay now ends at the BOTTOM of the grid, and
  `scripts/probe-clamp.ts` compares xterm against a real tmux pane
  token-by-token from a given cursor row — run it before trusting a mid-screen
  cursor restore.
- The replay frame carries **no trailing line terminator**
  (`ws/capture-text.ts:captureToReplayText`). `capture-pane -p` terminates
  every row including the last, and that final terminator scrolls the client
  one row past the pane's grid (measured on real xterm 6: `baseY` 1 vs 0),
  which shifts the whole viewport and makes the pane's viewport-relative
  cursor name the wrong row. Every later relative-positioned frame then lands
  on the wrong rows — the long-running "reopen a subshell and it is garbled"
  report. Verify with `apps/server/web/scripts/probe-replay.ts`.
  `captureToReplayText` still accepts an optional cursor and appends an
  absolute CUP; **no caller passes one today** (that was the quiet join's
  half). It is kept, and tested, for whatever replaces it.

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

## The server manages itself on an admin's request

Spec 2026-09-12 moved every server-UP management surface out of the Subshell
Server desktop console and into the SPA, so a browser on the LAN and a headless
install get it too. That meant it had to become HTTP. Five routes in
`api/admin-server/`, composed into the `adminRoutes` group and every one of
them behind `requireAdmin` — cookie session, admin role, bearer keys refused —
exactly like `GET /api/admin/status`:

| route | |
| --- | --- |
| `GET /api/admin/server` | how this server is DEPLOYED, as against `admin/status`, which is what is HAPPENING on it: config.env saved-versus-running, the service manager's answer, the data locations, whether a self-restart is possible |
| `PATCH /api/admin/server/config` | rewrite config.env through the CLI's own writer (below). `DATABASE_PATH` is deliberately absent — moving the database from a web page is a footgun with no undo |
| `POST /api/admin/server/restart` | exit for the service manager to respawn |
| `POST /api/admin/server/autostart` | arm or disarm start-at-login for the installed service. Inside the no-route rule rather than an exception to it: it touches nothing about the running process |
| `GET /api/admin/server/logs` | the tail of the server's own log file |
| `PUT /api/admin/server/logging` | the debug switch, applied live |

What did NOT become a route is the corollary of the same rule: stop, start,
install, uninstall and reset each leave the server unreachable, so a page
cannot be the thing that performs them. They stay with `subshell-server
service <verb>` for the headless operator and the desktop assistant for the
other one.

`GET /api/admin/server` carries no secret in any form, and its test asserts the
response's ENTIRE key set — the same rule `GET /api/settings/instance` carries,
so a field added later is a decision rather than an accumulation.

### Source attribution, and the systemd trap

`settingSource` (`services/server-deployment.ts`) answers which layer a
setting's saved value came from, and the PATCH route turns `process env` into a
**409 refusal**: a file write the next boot would mask is a success report for
a change that never happens.

That makes the rule load-bearing, and the obvious version of it is wrong.
"Is the key in `process.env`?" refuses every field of every PATCH on the
primary Linux deployment — because `service install` writes
`EnvironmentFile=<configDir>/config.env` into the unit, so systemd exports all
five keys before the process starts, `loadConfigEnv` finds them present and
applies none of them, and the whole file reads as environment-owned. It would
have looked like a correct safety refusal while making the Addresses card
read-only on every systemd host.

So the question is not "is it in the environment" but "would writing the file
take effect", and three rules answer it: a key `configEnvAppliedKeys()`
records (the loader put it there itself) is the file's; a key the environment
already held whose value the file also names is STILL the file's, because
systemd re-reads that file on the next start; anything else in the environment
genuinely overrides it. `collectStatus` has always attributed it the second
way — this brings the two into agreement rather than inventing a rule.

**Do not simplify this back to a presence check.** The unit is what makes it
wrong, and nothing in the type or the call site says so.

### `isSupervised` is the manager's pid, never a marker

`POST /api/admin/server/restart` restarts by EXITING, which is only a restart
where something respawns the process: `Restart=always`/`RestartSec=5` on
systemd, `KeepAlive=true` under launchd. The server cannot see its own manager
from its environment — the unit and plist templates set only `PATH`
(inventoried 2026-09-12) — so the honest question is asked of the manager
instead:

```
supervised = service.state === "running" && service.pid === process.pid
```

An environment marker was the alternative and it is worse in both directions:
it would be true for anyone who exported it and ran the binary by hand (exiting
into nothing), and false on every host whose definition was written before the
marker existed, until `service install` rewrote it. `MainPID` and `launchctl
print`'s `pid` name the process the manager actually started, so the comparison
is true exactly when exiting is a restart.

Pane safety follows the CLI: a definition without `KillMode=process` /
`AbandonProcessGroup` takes every live tmux pane down with the process, so the
route refuses it without `force` — the same bar `service restart --force` sets.

`performRestart` (`services/server-restart.ts`) closes every browser terminal
socket and every node socket with **1012 Service Restart**, then exits 0 after
a delay that lets the route's own 202 flush. 1012 is chosen for being BELOW
4000: the SPA's socket treats the 4xxx range as a refusal to report and
anything under it as a connection to retry, so the browser reconnects itself
rather than showing a rejection. The 202 carries `resumeAt`, the saved
`APP_BASE_URL`, because the restart may be the very change that moves the
address — a caller needs to know where the server comes back before its
connection goes. SQLite needs no close: bun:sqlite releases on exit and the WAL
is durable.

### The server's own log file

`<SUBSHELL_SERVER_DATA_DIR>/logs/server.log` (`status --json` reports it as
`paths.serverLog`): JSON lines, 0600 in a 0700 directory, capped at 200 KB and
**replaced when full**. One file, the same way on every platform, and nothing
in memory — including the HTTP request lines (operator direction 2026-09-12).
The console used to tail launchd's file on macOS and `journalctl` on Linux;
neither exists in a container, and a headless install may run under anything.
The manager's own log is still named in the deployment view
(`service.logPath` / `service.logHint`) for anything older than this file
holds.

**The writer is ours, and that was measured rather than preferred.**
`@loglayer/transport-log-file-rotation@3.3.0` with `size: "200k", maxLogs: 1`
was the intended one; the spike (2026-09-12, under plain `bun` and again
compiled) left FIVE files behind, each one over the 204 800 cap rather than
under it, deleted none of them, and wrote `<filename>.<n>` rather than the
filename it was given. `CappedFileTransport` (`utils/log-file.ts`) is the
replacement: a `BlankTransport` — loglayer's own `LoggerlessTransport` with a
supplied `shipToLogger`, so the level gate stays the library's and this needs
no dependency — appending a JSON line and truncating when the next one would
overflow. Truncating rather than dropping the oldest lines is what "replaced
when full" means, and it is why a partial line can only ever be the last one.

It creates its log directory on FIRST WRITE, not at module import. This module
is reachable from the CLI entry graph, which this package pins IO-free at
import (the import-purity invariant under "Subcommands" below); a `mkdirSync`
at import would be exactly the side effect those tests exist to forbid.

**The level policy is a split, not a level.** The pretty stdout transport is
pinned at `info` and left there, because that is what the service manager
collects and a debug session must not fill a journal. The FILE transport
carries the effective level, and `PUT /api/admin/server/logging` flips that one
field — live, no restart. HTTP request/response lines are emitted at `debug`
(`autoLogging.logLevel` in `plugins/context.plugin.ts`), so they reach the file
only in debug mode and the manager's log never; the polled routes
(`admin/status`, `admin/server`, its `logs`, `setup/status`,
`settings/public`, `/ws*`) are in that plugin's `ignore` list, or a debug
session would spend the 200 KB cap on the Service page asking how the Service
page is doing.

Debug logging is an instance setting (`settings` row `debug_logging`, absent =
off), read once at boot after migrations. `SUBSHELL_DEBUG_LOGGING=1` forces it
for a headless box or for the lines written before the database opens, and
while it is set the route answers **409** rather than writing a row the next
boot would override.

### The node Service surface

`/api/nodes/:id/service`, `/logs` and `/config` give an enrolled node the
management surface the plane already has for itself (spec 2026-09-12, node
half). Most nodes are HEADLESS — the agent is installed there, the GUI never is
— so a browser is the only place these questions can be asked at all.

| route | |
| --- | --- |
| `POST /api/nodes/:id/service` | start / stop / restart / install / uninstall, as one signed `service` command |
| `GET /api/nodes/:id/logs` | a byte range of the agent's OWN log file |
| `PATCH /api/nodes/:id/config` | repoint the node at another control plane |
| `PUT /api/nodes/:id/maintenance` | take the machine out of service, or put it back |

**Maintenance is owner-only for a THIRD reason**, neither of the two below
(spec 2026-09-14). It leaves the node perfectly reachable, so the structural
argument does not apply, and it is trivially reversible, so the repointing one
does not either. What decides it is blast radius: turning it on TERMINATES
every subshell running on that machine, and any node share lets a grantee
launch there, so those subshells belong to people the node's owner cannot
enumerate and who did not act. That is the delete/re-share gate's business
(`gate.canManage`, admins on `local`), not an `edit` grantee's. The count it
would stop rides `GET /api/nodes/:id` as `runningSubshells` on that same
narrower gate — whoever can pay the price is who gets told it. `local` is NOT
refused here, unlike the three routes below: the control-plane host is a launch
target like any other, and taking it out of service is the one management act
that means the same thing on every kind of node.

**`stop` and `uninstall` are owner-only, and the reason is structural rather
than a permission subtlety.** Every command reaches a node over the AGENT'S OWN
socket, so the plane can never start an agent that is not running: those two
end the connection that would have carried the verb undoing them. They are
one-way from a browser, reversible only by someone with a shell on that
machine. `restart`, `start` and `install` keep the `nodeCanConfigure` gate — they
leave the node reachable. **Repointing is owner-only too**, for a different
reason: the agent then dials whatever host was typed carrying a credential
valid on THIS plane, and the machine leaves this instance.

`local` is refused by all three, BEFORE the permission check — it is a
statement about the route rather than about the caller, and a 403 would send
someone looking for an owner to ask.

`POST /api/nodes/:id/service` is the same act one hop away: a signed command,
and the AGENT decides. Gate is cookie-only and `nodeCanConfigure`
(owner or `edit`, NOT `canManage`) — a `view` grantee may launch subshells on a
node, but driving its daemon interrupts everyone else's panes there. `local` →
400: the control-plane host manages itself through `/api/admin/server/*`,
which is a different act with a different gate, and routing it here would hand
a node's `edit` grantee a way to bounce — or stop — the control plane. No new
trust either way — the plane already runs arbitrary launches on an enrolled
node.

The agent's refusals map to 409 `NODE_NOT_SUPERVISED`,
`NODE_RESTART_KILLS_PANES`, `NODE_NO_SERVICE`, `NODE_AGENT_TOO_OLD` (its
`unsupported` answer) and `NODE_OFFLINE`, with anything unrecognized falling
through to `NODE_UNREACHABLE` rather than being guessed at. `force` is REFUSED
(400) on `start` and `install`: it means "act even though live panes will die",
so a flag silently accepted where it does nothing is how a caller learns it is
noise, and then passes it where it is not.

**That mapping compares `NodeRpcError.detail` by EQUALITY**, against the
protocol's own `NODE_RESULT_*` constants. `detail` is the agent's
`result.error` verbatim and exists for this: `message` wraps it in a sentence
(`node "x" reported: …`) that is right for a log line and wrong for a decision.
Matching a substring of it would have re-read `"not supervised enough,
honestly"` as the exact refusal, and would have changed meaning silently the
day someone reworded that sentence in `node-rpc.ts`.

The agent answers `NODE_RESULT_KILLS_PANES` for `paneSafety: "unknown"` as
well as `"kills"` — its destructive verbs fail closed on a definition they
could not read — so only the plane can tell the two apart, and it does so in
the WORDING and never the code. Telling someone their panes will die when the
truth is that nobody could read the definition is the kind of certainty that
teaches people to ignore warnings.

`runtime` (the agent's report of how its own process runs) lives on the LIVE
CONNECTION, never in the `nodes` table, and `GET /api/nodes/:id` exposes it
only when the node is online, the viewer can configure it, and the row is an
agent. These are facts about a running process: offline, they are stale by
definition, and their absence is the honest answer.

## Standalone binary & CLI

`src/index.ts` is BOTH the boot entry and the `subshell-server` CLI entry:
`bun build --compile` of it yields a self-contained binary — no bun, no repo
checkout on the host, and the built SPA **embedded** (see below). The boot
contract is untouched: no subcommand, or a leading flag, IS the boot path, so
a systemd unit whose `ExecStart` names the binary (or `bun <entry>`) with no
subcommand boots the server exactly as before (spec 2026-09-03). That form
predates the CLI — it is what the removed `svc.sh` wrote — and the tests pin
it, so never make a bare invocation mean anything else.

### Subcommands (hand-rolled dispatch in `src/cli.ts`, no flag library)

| Command | |
| --- | --- |
| `version` | print `subshell-server <version>` and exit |
| `status` | "what WOULD this boot with" — opens with the `subshell-server <version>` line byte-identical to `version` (ONE fact, ONE spelling), then config.env path/existence, layer-tagged settings, masked secret (never echoed), tmux presence, mcp entrypoint, plugin registry, port liveness, service definition on disk; reads only, never boots. `--json` emits the same facts as a machine-readable `StatusView` (never the secret — only `set`/`missing`). Each setting carries its layer as `source`, and `default` vs `config.env`/`process env` is what lets a consumer tell "the server would boot with this" from "somebody chose this" — the desktop console seeds its form on exactly that distinction. A setting may also carry `problems` — per-entry diagnostics saying what a BROWSER will do with a value the boot accepts (a schemeless origin, a non-canonical one, a base URL that silently drops the instance's own origin). Absent when clean, never `[]`, and never a verdict: see below |
| `init` | first run: config home (0700), `BETTER_AUTH_SECRET` bootstrap (file value > env adoption > fresh 32 random bytes base64url), then the configure flow |
| `configure` | (re)write config.env; interactive unless `--yes`; flags `--port --host --base-url --trusted-origins --db-path --yes` |
| `service install` | write + enable/start the per-user service (refuses before any write without a config.env — run `init` first). `--no-autostart` installs one that runs NOW but does not come back at login. On Linux it then asks logind whether the user lingers, and prints the `loginctl enable-linger` advice only when the answer is not yes — the hint used to print on every install, which told an operator who had already fixed this to go and fix it (`null`, i.e. no loginctl and no bus, still prints: unneeded advice is cheaper than a reboot that loses the server) |
| `service uninstall` | stop + remove the service definition (deliberately never gates on config/tmux — a stranded unit must always come down) |
| `service enable` / `service disable` | arm or disarm start-at-login, WITHOUT touching the running process. Linux: `systemctl --user enable\|disable` with no `--now` — that flag is the whole difference between a preference and an outage. macOS: the plist MOVES (below) |
| `service status` | what the MANAGER reports — run state, pid, starts-at-login, and whether a teardown keeps live panes; `--json` for scripts. Always exits 0: a view must not make a caller distinguish "not running" from "the call failed" |
| `service start\|stop\|restart` | drive an already-installed service. Never installs one — `start` must not become a way to background a server whose config was never checked |
| `mcp` | serve the pane-spawned stdio MCP server (the self rung of MCP resolution below); the one long-running command — spawned by harnesses, not typed by humans |
| `report attention turn_complete\|needs_attention`, `report session` | out-of-band reporting from a harness HOOK: attention signals, and the pane's current conversation id (read from the SessionStart payload on stdin — only `session_id` is forwarded). Run by generated hook command lines, never typed. ALWAYS exits 0 and prints nothing, even on an unreachable server or an incomplete pane env — a hook's stderr and exit code land in the user's session, and a lost report costs one notification, never a turn |

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

### Boot output

Boot opens with the `/subshell` wordmark, then `subshell-server <version>`.

The wordmark in `src/banner.ts` is **hand-set for the terminal**, and that is a
decision rather than an oversight. Rasterizing `brand/src/wordmark.svg` was
tried first — it would have kept the banner sourced from the master — but
Acherus is a hairline face, and at the ~12 pixel rows a banner can afford every
weight in the family thresholds into uneven, broken strokes. It reads as wrong
rather than as small. This is the 16px-favicon problem with the usual answer:
below a certain size a mark is REDRAWN for the grid, not resampled onto it.
The COLOURS are still the master's own values, since a palette is the part that
can silently drift.

It is **plain ASCII** — `#` and `+`, no block elements or box drawing. Those
depend on the font rendering them at exactly the cell box and the seams show in
a lot of terminals. The `#`/`+` split is not decoration either: it draws the
same `sub`/`shell` boundary the colour does, so the two-tone survives a
journal, a piped log, or a terminal without truecolor. Those are two
independent constants describing one edge (the characters, and `SUB_END` in the
painter), which is exactly the kind of pair that drifts silently — a test pins
them together.

It reaches stdout through a LogLayer **group** (`BANNER_GROUP` in
`utils/logger.ts`) bound to its own unprefixed `ConsoleTransport`. The pretty
transport stamps `[time] INFO` on a message's first line, which would shear the
top row off the letterforms — and writing to `console` directly would put an
unmanaged writer back into a codebase that routes everything through LogLayer.
`ungroupedBehavior: ["pretty"]` keeps ordinary logs on the prefixed transport
only; without it every line would print twice.

Colour is 24-bit ANSI, taken from the master's own fills, and is emitted **only
when stdout is a TTY** — under systemd or launchd it is not, and escape codes
written into a journal are something an operator has to read around forever.

### config.env (`src/config-env.ts`)

`~/.config/subshell-server/config.env` — home overridden by
`SUBSHELL_SERVER_CONFIG_DIR`; dir 0700, file 0600, written via temp +
rename. `constants.ts` itself applies it with SETDEFAULT semantics at the
top of its own module body, BEFORE its dotenvx call, so the precedence is
**process env > config.env > `.env` (dotenvx, when the CWD has one) >
built-in defaults**. The application lives in `constants.ts` rather than in
`cli-bootstrap.ts` on purpose and by measurement (2026-09-07): the
bootstrap's body runs AFTER the whole import graph has evaluated — its own
first import (`@/cli.js` → `commands/status.js` → `constants.js`) reaches
constants first — so a bootstrap-side apply silently did nothing on macOS,
where launchd has no `EnvironmentFile` to mask the gap the way the systemd
unit does. `cli-bootstrap.ts` keeps its (idempotent) call for the CLI path;
the regression test spawns the real entry and asserts the FILE's value
reaches the RUNNING process (`__tests__/cli-entry.test.ts`). One visible
consequence: `bun run dev` now honours the developer's own config.env too —
a `configure`d `DATABASE_PATH` relocates the dev server on its next restart.
That is the point (one machine, one configuration), but it is why
`e2e/stack.ts` points `SUBSHELL_SERVER_CONFIG_DIR` at its own temp dir —
anything that boots the server for test purposes and wants stock config must
override the home, not merely avoid setting variables. `configure` owns five keys — `SERVER_PORT`, `HOST`,
`APP_BASE_URL`, `DATABASE_PATH` and `TRUSTED_ORIGINS` — and `init` persists the
secret (an existing value is never rotated).

**`applyConfig` is the ONE writer.** The merge over the stored values, the
per-key `validateValue`, the origin canonicalization, the two address warnings
and the atomic preservation-preserving rewrite are one exported function
(`commands/configure.ts`), called by `runConfigure` and by
`PATCH /api/admin/server/config` alike. So the component-wise validation
`docs/security.md` §8 leans on is true of the web surface because it IS the
CLI's code, not because a second implementation was kept in step. Be exact
about what carries that claim: no test diffs a route-written file against a
CLI-written one — the shared CALL is the guarantee, and there is simply no
second writer to drift. What the route's own test pins is narrower (the write
lands, foreign keys survive, the audit metadata holds no secret).

**Validation therefore runs twice, on purpose.** `runConfigure` checks each
answer at its own prompt, so an interactive typo dies at the question that
produced it rather than after four more questions the person would have to
retype; `applyConfig` then checks the whole set again, because the API path has
no prompts to die at. Both passes call the same `validateValue`, so this is one
set of rules in two places rather than two sets. The same is true of the
leniency: a value byte-identical to what is already stored is kept with a
warning in both, which is what keeps a hand-written wildcard from wedging an
unrelated port change.

Two things about that set are load-bearing and were both bugs first:

- **Defaults follow the FILE, in every mode.** A stored value is the default
  for its question, so ENTER through an interactive re-run *and* a `--yes` run
  given no flag for that key both keep what is configured. `--yes` used to
  answer with the built-ins alone, which made a scripted re-run a RESET of
  every unflagged key — contradicting `init`'s own idempotence contract, and
  with a live victim: the desktop console's save is a non-interactive
  `init --yes --port … --host …`, so changing the port there repointed
  `DATABASE_PATH` at the config-dir default and threw away a customised
  `APP_BASE_URL`. Flags still outrank the file everywhere. The other half of
  that interaction is WARNED rather than silently fixed: preserving a stored
  `http://box.local:3080` across `--port 4000` leaves a base URL naming a dead
  port (and an allowlist around the wrong origin), so `configure` says so when
  the base URL names a concrete non-default port that disagrees with the bind
  port. A default-port base URL is a PROXY, not a mismatch — warning on
  `https://subshell.example` in front of `:3080` would fire on every correct
  production config.
- **`TRUSTED_ORIGINS` is written or REMOVED, never written empty**
  (`OPTIONAL_KEYS` in `commands/configure.ts`). The other four have a built-in
  default worth writing down; this one's built-in default is a non-empty list
  (the dev Vite origins), so a `TRUSTED_ORIGINS=` line would be a
  SETDEFAULT-visible empty value that beats `.env` in the ladder and silently
  strips those origins on a developer's own machine. `--trusted-origins` is
  therefore the ONE value flag whose empty value is accepted — that is how
  "clear the list" is said, now that omitting a flag means "keep the stored
  value". Entries are validated by COMPONENT (http(s) scheme, a host, no
  path/query/fragment) and STORED as `URL.origin`, so the spellings people type
  — a trailing slash, a mixed-case host, expanded IPv6, an explicit `:443` —
  are accepted and written in the one form both consumers match; embedded
  credentials are refused rather than silently dropped. The refusal names the
  offending entry. **Wildcards are refused explicitly**, before that check,
  because `URL.origin` round-trips them: better-auth routes any `*`/`?`
  pattern through `wildcardMatch`, so `https://*` would trust every https
  origin. See `docs/security.md` §8 — that refusal is what makes the
  static-allowlist claim true of anything these surfaces can write.

`localOriginsFor` serializes every derived entry through `URL.origin`, and that
is load-bearing rather than tidy: as string concatenation, `http://<host>:80`
on a port-80 deployment matched nothing a browser sends (80 is the scheme
default, so the `Origin` header carries no port), and a mixed-case `HOST` never
matched either — a derived entry that LOOKS like it covers the LAN address
while being dead weight. Extend the `localOriginsFor` describe in
`__tests__/trusted-origins.test.ts` when touching it; `port: 80` and an
uppercase host are the cases that catch this class.

**Why the diagnostics live in `status` and not at boot.** Neither refusing nor
warning at boot works. A throw in `constants.ts` would brick every subcommand,
`configure` included — the one command that could repair the value, which is
the `SERVER_PORT=70000` precedent already in the tree. And a boot WARNING
cannot name the LAYER the value came from, so a process-env override of a
correct `config.env` would send the operator to edit the file they got right.
`status` is read-only, always exits 0, already carries per-key attribution, and
is what the desktop console reads — so the diagnosis reaches the surface
someone runs BECAUSE sign-in is failing, and the console renders it beside the
field that changes it. `originProblem`/`baseUrlProblem` live in
`commands/config-values.ts` and share primitives with the validator rather than
duplicating it: a `status` that called a value unusable when `configure` would
accept it (or the reverse) would make the tool look broken instead of the
config. Wildcards are the deliberate silence — better-auth honours them, so
flagging one would be a lint against a supported feature.

Why the key is asked about at all: `constants.ts` derives the allowlist from
the port, a CONCRETE `HOST` and the base URL. On the default `0.0.0.0` bind the
host is skipped (a wildcard is a listen address, not one anyone visits) and
`APP_BASE_URL` defaults to `http://localhost:<port>` — so the whole derived set
is the two loopback spellings, and a phone or a second hostname on the LAN
sends an `Origin` nothing matches and sign-in dies on 403 "Invalid origin".
Nothing about that failure names the key that fixes it, which is why it is a
question rather than a hand-edit. `DEFAULT_TRUSTED_ORIGINS` lives in
`constants.ts` and is imported by `status`, so the reported default cannot
drift from the one the boot uses.

tmux preflight: `init`, `configure` and
`service install` refuse before any write when tmux is absent (the `local`
node launches every pane through it); escape hatch
`SUBSHELL_SERVER_SKIP_TMUX_CHECK=1`. On an INTERACTIVE run the preflight
first OFFERS to install tmux (`commands/tmux-install.ts`: brew on macOS,
`sudo apt-get`/`dnf` on Linux — fixed argvs, inherited stdio so sudo prompts
in the user's own terminal) and CONTINUES the command on success — no rerun.
`--yes`, no TTY, a declined prompt, or no supported installer all fall back
to the plain refusal, byte-identical to before (CI never gets asked).

`service install` (`src/service.ts`) writes `subshell-server.service` under
`~/.config/systemd/user/` — **one owner per host**: the retired `svc.sh` wrote
this same path from the repo's `.env`, so a host upgrading from it must
uninstall that unit before installing this one (README, "Host service") — with
`WorkingDirectory=` and
`EnvironmentFile=` pointed at the config home (systemd and the binary's own
loader read the same file, so they cannot disagree), the installing shell's
PATH baked (a Homebrew/Nix tmux would vanish under the manager's stock
PATH), `StartLimitIntervalSec=0` (Restart=always must survive an
EADDRINUSE crash loop), and `KillMode=process` — the load-bearing one: each
local subshell's tmux server is a CHILD of this unit, so the default
control-group kill SIGKILLs every live pane on stop/restart. A host whose unit
lacks it loses all running subshells on the next `systemctl restart` — and on
a plain `systemctl stop`, since a restart is a stop plus a start (measured,
2026-09-03). `src/service.ts` carries the reasoning; the unit text is pinned by
test. Since 2026-09-05 that hazard is ENFORCED rather than merely documented:
`queryService` asks systemd for the EFFECTIVE `KillMode` (a unit-file grep
cannot see drop-ins under `subshell-server.service.d/`), `service restart`
refuses on a host whose definition would kill panes (`--force` overrides),
`service stop` warns and proceeds, and `service status` reports it as
`teardown keeps panes`. Both destructive verbs fail CLOSED on an unreadable
definition — `unknown` is not evidence of safety.

**On macOS "starts at login" is the plist's LOCATION, not a key inside it**
(spec 2026-09-12 server-supervision), and both flag-shaped alternatives were
measured and rejected — read this before "simplifying" it back to `RunAtLoad`:

- `RunAtLoad=false` does not stop it. The plist carries `KeepAlive=true`,
  which starts a job when it is LOADED regardless. Measured on macOS 26.6.2: a
  throwaway agent with that exact pair reported `state = running, runs = 1`
  two seconds after `bootstrap`, while the same agent without `KeepAlive`
  reported `runs = 0`. Switching `KeepAlive` to its dictionary form to dodge
  that would break restart-by-exit, which `performRestart` relies on.
- `launchctl disable gui/<uid>/<label>` is worse: a disabled service refuses
  `bootstrap`, so "running now but not at login" cannot be expressed at all —
  and the mark lives in launchd's per-uid override database, survives
  `service uninstall`, and makes the next fresh install fail with the generic
  EIO `bootstrapDarwin` already has to apologise for.

launchd auto-loads exactly `~/Library/LaunchAgents` at login, so **enabled =
the plist is there; disabled = the same document lives in the config home**
and only an explicit `bootstrap` (which `service start` does) loads it. Moving
it restarts nothing — launchd holds the loaded job, not the file — which is
what makes `enable`/`disable` safe for a running server. `queryService` reads
`enabled` from WHERE the definition is, `uninstall` removes both locations,
and the control verbs bootstrap `state.definitionPath` rather than assuming
the login path.

**On Linux "starts at login" is only half the answer, and the missing half is
`linger`.** A `systemd --user` unit runs inside its owner's login session: an
enabled one comes back when that user logs IN and dies when they log out, so a
headless box nobody logs into never starts it at all. `loginctl enable-linger
$USER` is what decouples the two — after it, the same enabled unit comes back
at BOOT with nobody logged in. The defect that closes is an operator who
believed a server was armed because the only switch on screen said "start at
login" and was on, and then rebooted the machine and lost it. `queryService`
therefore reports a SEPARATE `linger` field beside `enabled` rather than
folding one into the other: they are two independent facts, and it is asked
regardless of `enabled`, on the `systemctl show` success branch only.

**The probe's argv and its answer-mapping are SHARED with the agent's twin of
this module**, in `@internal/subshell-protocol`, and that is the one exception
to the ports-are-duplicates rule. Each side still owns its platform logic and
its call sites; what is shared is `lingerFromProbe`, which parses ANOTHER
PROGRAM'S error text with a regex, and `lingerVerdict`, the `service status`
string that has to read identically on both CLIs. Those two are where a
divergence would be silent rather than loud — and silent-and-wrong on a
headless host is precisely what this fact exists to prevent.

The probe is `loginctl show-user <uid> --property=Linger`, by UID and never by
username — `ServiceDeps` already carries a uid for the launchd domain target,
and `os.userInfo()` THROWS for a uid with no passwd entry, which is the
ordinary state of a container. Three answers, and the middle one is the one to
get right: `Linger=yes|no` on a clean exit is logind's own word; a NON-ZERO
exit whose output says the user is "not logged in or lingering" is ALSO logind
answering — no session record means no session and no linger, so `false`, not
unknown, and it is the normal reply for a service user on a box nobody logs
into; anything else (no `loginctl` on PATH, no bus to connect to) is a question
that never reached logind, so `null`. It is `null` on macOS too, and that is an
absence of the question rather than an unknown answer: a LaunchAgent's lifetime
IS the login session by design, so there is nothing there to be yes or no
about. `service status` renders it as `survives logout` for a systemd
definition and omits the line entirely for a launchd one.

macOS: launchd agent `dev.subshell.server` →
`~/Library/LaunchAgents/`, log `~/Library/Logs/subshell-server.log` (reported as
`logPath` in `service status --json` — the desktop app reveals it rather than
re-deriving the platform path; Linux reports `null` because the journal holds
the output). The plist carries `AssociatedBundleIdentifiers =
[dev.subshell.server]` so System Settings' Login Items labels the job **Subshell
Server** with the app's icon instead of falling back to the signing
organization, and `WorkingDirectory=` the config home so a relative
`DATABASE_PATH` lands there rather than in `/`. The bundle id is the protocol
constant `DESKTOP_SERVER_BUNDLE_ID` — the plist label, the association and the
desktop app's own identifier must stay one string or the attribution silently
detaches. `service status` reports what launchd says VERBATIM: a crash-throttle
wait shows as `launchd: spawn scheduled`, and a `launchctl print` failure that
is not "Could not find service" (exit 113) is `state: unknown` with the stderr
in `detail` — a manager that would not answer is not the same fact as a service
that is stopped.

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
user hits it.

**The harness-hook reporter shares that ladder, minus the override.**
`probeReporterLaunch` answers the same host question for `<self> report …`,
the command a harness hook runs to report attention and conversation identity.
It skips the `SUBSHELL_MCP_COMMAND` rung on purpose: that variable names an MCP
*server*, which an operator may point at a wrapper with no `report` verb, and
honouring it would turn a working MCP override into broken hooks in every pane.
Unresolved is a real answer here rather than a throw — the plugin omits its
hooks instead of baking a command the pane cannot run. For a subshell on an
agent node the reporter is composed from that node's own reported
`selfInvoke` prefix instead (`nodeSelfInvoke`), because a hook runs where the
pane runs and the control plane's own path means nothing there. The hooks used
to be `bun -e '<inlined JS>'`, which assumed a bun on the pane PATH — true of
the container image, false of every desktop install, where Claude Code opened
each session on `bun: command not found` and neither notifications nor
restart-resume identity ever worked.

(`subshell-server mcp` became possible once the entry graph was
IO-free at import — lazy `getAuth()`, purity-tested — so a long-running
subcommand can no longer drag the boot graph into side effects; the 1.3.x
companion-binary era that made a separate tiny entry necessary is retired.)

### Embedded SPA + release dance

`selectStaticPlugin` picks the static source at boot: an on-disk frontend
dist wins (so a dev run and a checkout-based service behave identically),
else the SPA baked into the
binary by `scripts/embed-web.ts` (`src/generated/embedded-web.ts` — a
TRACKED stub keeps the unconditional import legal on a fresh clone;
embedded responses carry a strong `ETag`, the tell of memory mode), else
boot fails loudly. Caveat measured on bun 1.4.0: the compiled binary bakes
its BUILD-TIME source path into `import.meta.url`, so on the build machine
the repo's own `apps/server/web/dist` shadows the embedded copy — hide that
path (e.g. a bind-mount sandbox) before asserting embedded mode is live.

From the repo root:

```bash
bunx turbo build           # 1. apps/server/web/dist must exist (embed preflight)
bun run release:server     # 2. = apps/server/api compile:release (src/scripts/release.ts)
```

The pipeline embeds the SPA (the generator overwrites the stub; the stub is
restored with `git checkout` in a `finally` — embedded bytes are release
noise, never a commit), builds the three `SERVER_TARGETS` triples
(`linux-x64`, `linux-arm64`, `darwin-arm64` — no darwin-x64, since Intel
Macs are not a target for any component;
`@internal/subshell-protocol` `paths.ts`) — one binary per triple: the
SPA-embedded `subshell-server-cli-<triple>` (the `cli` marks it as the bare
binary, not the desktop app that wraps it; an install renames it to
`subshell-server`), which serves its own `mcp` subcommand so a server-only
host self-resolves its MCP entrypoint — each with `--bytecode` (bun ≥
1.4.0 asserted; `SUBSHELL_SERVER_RELEASE_TRIPLES` scopes a subset for CI),
darwin targets are signed + notarized first when `SUBSHELL_RELEASE_SIGN_CMD`
is set (CI sets it to `scripts/macos-sign-notarize.sh` on the darwin shards — see
root `AGENTS.md`; unset locally, so plain release runs skip the hook),
and publishes atomically (tmp + rename + `.sha256` sidecar) to
`SUBSHELL_SERVER_RELEASE_DIR`, default `<repo-root>/dist-server` — an
operator drop dir to scp/deploy, not a data-dir ladder like the agent's
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

**A run reaps its own tmux servers, and that net lives in the `test` script,
not the preload.** The script prefixes `TMUX_TMPDIR=$(mktemp -d
/tmp/subshell-test-tmux-XXXXXX)`; tmux resolves `-L <name>` under it, so the
preload's `afterAll` can `kill-server` exactly what this run started by
listing a directory, and a concurrent run's panes are outside it. What leaks
without it is not a socket file but a live harness: measured 2026-09-14, 17
real `claude` panes at ~220 MB each were alive on a developer's machine, the
oldest a day old, one per full `bun test` since — from
`subshells-local-launch-off.test.ts`, which asserted `not 403 / not 404` on a
create and got a 409 on CI (no claude) and a genuine 200 on a dev box. That
suite now pins `CLAUDE_PATH` at a path that does not exist, which is the real
fix; this is the net under it, for the leak classes a per-file `afterAll`
cannot catch (a launch that throws before its socket is registered, a file
with no reaper, a timeout that ends a file before its hooks).

Two measured facts fix WHERE the variable is set. A child does not see a
`process.env` written after startup (bun 1.4.2): Bun hands a spawned process
the environment this one was STARTED with, so setting it in the preload
reaches `tmuxSocketPath()` in-process and not the tmux client — the socket
would land in `/tmp` while `cleanSocket` unlinked a path in the temp dir,
which is worse than no net. And `/tmp` rather than `$TMPDIR`: on macOS the
latter is a ~49-byte `/var/folders/...` path against a 104-byte socket-path
cap, so the derived socket lands within a few bytes of tmux's bare "File name
too long". A bare hand-typed `bun test` sets no such variable and gets no
net — correctly, since it also gets the shared default socket dir, where
killing anything would reach panes this run never started.

**The net covers this package only.** `packages/pane-runtime` and
`apps/node/agent` also spawn real tmux and run a bare `bun test`, so nothing
sweeps behind them; what stands there is each suite's own `afterAll`, which
registers a socket BEFORE spawning on it (`freshSocket` in
`tmux-runner.test.ts`) and so has no window to leak through. That is a
narrower guarantee than this one — it holds as long as every future suite
keeps registering first — and it is stated here rather than fixed because
extending the variable to those packages is a change to how their sockets are
named, not a line of cleanup.

**The `--timeout 30000` in the `test` script is measured, not caution.**
This package's suites set up against that shared DB through migrations and
better-auth table creation, and bun's 5000 ms per-test/hook default blew
three times in three CI runs, each time in a different file — which is the
signature of load, not of a bug: the auth-registration `beforeAll` at
8830 ms (run 34581907693), the heaviest `default-profiles` case (suite since
removed — the seeding went with spec 2026-09-13) at 5508 ms with siblings at
242-298 ms (run 34583881882), the `passkey-plugin`
`beforeAll` at 5428 ms (run 34584698469). Every one PASSED on an idle
machine and failed with "timed out", never an assertion. Per-file budgets
were tried first and abandoned as whack-a-mole: the unit that is actually
slow is this package's setup, so the fix is the package's script. A
genuinely hung test still fails — at 30 s, with a named duration, rather
than at a number chosen by the runner's defaults.

Route tests live in `__tests__/` next to the route and share
`src/api/__tests__/helpers/auth-tables.ts`:

- `setupAuthTables()` — runs the real app + better-auth migrations once per suite
- `signIn(email, password)` / `authedRequest(...)` — real session cookies
- `deleteUserByEmailOrId(...)` — per-test cleanup

Migrations must be applied by the code under test or the helper — never
assumed from a developer's local `data/subshell.db`.

**`test` must keep turbo's `dependsOn: ["^build"]`** — do not narrow it for a
faster loop. This package once overrode it to
`["@internal/backend-errors#build:dev"]`, which let `@internal/server#test` run
CONCURRENTLY with a dependency's build. `tsdown` cleans `outDir` before writing,
so `packages/subshell-protocol/dist` vanishes for a moment mid-run — and
`__tests__/cli-entry.test.ts` spawns a REAL subprocess (`bun src/index.ts`),
which is the one place that re-resolves the workspace package from disk rather
than from the parent's module cache. The child died with `Cannot find module
'@internal/subshell-protocol'`, surfacing as a rare "configure must not boot"
failure that passed in isolation and on every re-run. `@internal/server#build`
failed the same way, less often. The override is gone; the root config is
correct and this package now inherits it.

Separately, the repo-root `e2e/` suite drives this server as a real subprocess
(`bun src/index.ts` with `NODE_ENV=development` against a temp-file DB and a
stub `pi` harness on port 3199) — a full-stack check that is deliberately
outside `bun test`. It is launched by `bun run test:e2e`, never by `turbo test`.
