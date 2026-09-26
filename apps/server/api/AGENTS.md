# Server AGENTS.md

Server-specific documentation for the ElysiaJS API server (`apps/server/api`, `@internal/server`).

## URLs

- API server: http://localhost:3080 (`SERVER_PORT`/`HOST` env, see `src/constants.ts`)
- OpenAPI docs (Scalar): http://localhost:3080/docs
- Production single-port model: the same server serves the built SPA
  (`src/plugins/static.plugin.ts` serves `apps/server/web/dist`); there is no
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

Both scripts run from `apps/server/api` only: `bun run ./src/index.ts` and friends
fail from the repo root, where workspace resolution does not apply.

```bash
bun run scripts/set-admin-password.ts <email> <new-password>   # forgotten dev admin
bun run src/scripts/e2e-seed.ts create|token|ciphertext        # e2e fixtures
```

`set-admin-password.ts` opens `./data/subshell.db` **hard-coded**; it ignores
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
`data/`); there is no Postgres and no Docker for tests. Migrations live in
`src/db/migrations/` **and** must be registered in the provider map in
`src/db/migrate.ts`; the boot migrator reads the static map because dynamic
imports break `bun build --compile`. File name and map key must match.

## Architecture

Routes are flat resource modules in `src/api/` (`files.route.ts`,
`presets.route.ts`, …), aggregated in `src/api/routes.ts` (the off-the-tree
precedents are `auth-rate-limit.route.ts`, for route precedence, and the
root-mounted `install-script.ts`, because `/install.sh` is a dotted top-level
path the static SPA plugin would 404; both mount directly in `server.ts`).
Most sit behind `src/api/auth-guard.ts`, which derives `user` (session cookie
or bearer key), provides `requireAdmin` (bearer keys are rejected on admin
surfaces), and defines the `status`-carrying error classes Elysia maps to HTTP
codes. `src/server.ts` composes the app; `src/index.ts` boots it (runs
migrations, then listens).

**Sign-in providers (spec 2026-09-24).** Provider config lives in the
`auth_providers` table; the E-mail provider is row `email`, and its
`registration_enabled` IS the old global registration switch. The
better-auth singleton is rebuilt (`invalidateAuth()`) after every
successful `/api/auth-providers` write, FAIL-TOLERANT and from endpoints
resolved at SAVE time: discovery never runs at build, so a dead issuer
crashes neither boot nor a rebuild. Provider policy is ONE global seam
(`options.user.validateUserInfo`, with `hooks.before` guards carrying
the two password/passkey sign-in refusals). No write may close the LAST
open sign-in provider (409 `LAST_SIGN_IN_PROVIDER`).

**Working on auth providers or the sign-in policy seams: read
`apps/server/api/docs/auth-providers.md` first.**

```
src/
├── api/            # Routes: flat *.route.ts (incl. downloads.route.ts, admin-status.route.ts, plugins.route.ts) + per-resource dirs (subshells/, workspaces/, channels/, nodes/, users/, auth-providers/) + auth-guard.ts + routes.ts; install-script.ts renders GET /install.sh (full comments: apps/server/api/docs/source-tree.md)
├── auth/           # Api-key store, DB handle, system user, the sign-in providers (provider-policy.ts, provider-guards.ts, provider-rows.ts, oidc-discovery.ts; better-auth config: ../auth.ts)
├── db/             # Kysely setup, migrations (static provider map), types/, repositories/
├── lib/            # context.ts (ApiContext + getRequestlessContext), api-error.ts (apiErrorBody)
├── plugins/        # auth.plugin.ts (better-auth handler mount), context.plugin.ts, error-handler.plugin.ts, static.plugin.ts
├── schema/         # Shared response schemas (error.type.ts: ApiErrorResponseSchema)
├── scripts/        # e2e seed, embed-web.ts (SPA -> generated/embedded-web.ts), release.ts
├── services/       # Business logic: subshell-manager, nodes/ (NodeLauncher seam), channels/, uploads, tokens, audit, notify, mcp-launch (TmuxRunner lives in `@internal/pane-runtime` now, so the node CLI can reuse it)
├── utils/          # Logger and small shared helpers
├── ws/             # Terminal attach WebSocket (short-lived single-use tokens — cookie-minted ones unscoped, Bearer-minted ones bound to one subshell) + the dashboard's live feed: live-ws.ts, live-topics.ts (the recipient set, diffed against resolveSubshellAccess by an exhaustive test) and live-publisher.ts (coalesced broadcasts). Full comments: apps/server/api/docs/ws-attach.md
└── test-preload.ts # Loaded by bunfig.toml before every test run
```

The nodes READ surface widened once (spec 2026-09-25 MCP DX): `GET /api/nodes`
now answers a bearer machine token with its owner's own nodes (owner-only, no
shares, no admin boost, disclosure-only), the door the MCP `list_nodes` tool
rides; `GET /api/nodes/:id` and every nodes write stay cookie-only. The
accounting is `docs/security.md` §3 and the pins are
`api/nodes/__tests__/nodes-list-bearer.test.ts`.

The Nodes plane serves the prebuilt `subshell` binaries from
`NODE_ARTIFACTS_DIR` at `GET /api/downloads/node/*` (cookie,
unconsumed setup key, or a still-valid one-time `?update_token=`; never
anonymous), and on the 404 branch fetches the binary LAZILY from the
project's own `cli-node-v*` GitHub release, streaming it through while
hashing against the SIGNED manifest's `assets` map. Which release a node
is OFFERED (`NODE_PROTOCOL_VERSION` matching), the three-way refusal
grammar, disk-wins versus release-coherent serving, and the surfaces
that report the on-disk set:

**read `apps/server/api/docs/node-artifacts.md` first.**

Plugins live on the control plane (spec 2026-09-10): the door is
`api/plugins.route.ts` (`/api/plugins`: list for any authenticated
actor; install / enable / impact / uninstall cookie-admin only).
`<dataDir>/plugins/` is the ONE installed set; "usable" is (instance
installed ∧ `plugin_state.enabled`, absent row = enabled) × (this
node's detection found the binary), computed once in
`api/harness-utils.ts` for every node alike. The plane RESOLVES the
set: `services/nodes/local-plugins.ts` points the pane-runtime registry
overlay at the store at boot and after every install and uninstall, so
`getHarness` answers for a registry-installed plugin the moment the
install returns. Built-in ids always resolve to the compiled copy, and a
registry package claiming a built-in id is warned about once and never
loaded, which is why `plugins.route.ts` and `setup.route.ts` read
`builtInHarnesses()` for their catalog. A registry `spec` installs
VERBATIM; the URL is `SUBSHELL_PLUGIN_REGISTRY_URL`; the anonymous setup
route has NO spec field, forever.

**Working on the plugins routes, the store, seeding or the overlay:
read `apps/server/api/docs/plugins-on-the-plane.md` first.**

Repositories (`src/db/repositories/`) are the primary Kysely writers; each
resource's row types are in `src/db/types/`. A few small writes bypass them
today (`authAttempts` in `auth-rate-limit.route.ts`, `userMeta` in `auth.ts`).
**A subshell write that a person should see must also announce itself.** The
live feed is event-driven (spec 2026-09-19), so `publishLive({ kind:
"subshell.changed", id })` beside a write is what makes the dashboard move
(`services/live-bus.ts`, consumed by `ws/live-publisher.ts`). It belongs in the
SERVICE that owns the act, never in the repository, which contains database
calls only; and it is announced ONCE PER ACT rather than per write, since one
launch writes the row, mints its token and patches it post-spawn. The
publisher coalesces per id over a 40 ms window, so announcing liberally at act
boundaries costs nothing on the wire. There is ONE announced write that is no
one's act: the attach relay's output stamp (`persistOutputFor`,
`ws/viewers.ts`) writes `lastOutputAt` at most every 2 s per pane and announces
it, because that stamp IS what the UI renders (the blinking printing dot
derives from it against the clock) and on an agent node the relay is the ONLY
fresh writer (the 60 s mtime sweep is LOCAL-ONLY by design). The 2 s throttle
is what keeps it a stamp rather than per-frame noise. Not free server-side
either: every coalesced `changed` costs the publisher a row read and its
shares read even with no subscriber watching, so each attached, printing pane
pays a read cluster per 2 s, same one-read-per-event posture as the sweep.

Two pane doors arrived with spec 2026-09-25 (MCP DX), and they sit on the
launcher's existing seams rather than new ones. `POST /api/subshells/:id/input`
(`input-subshell.route.ts` + `SubshellsService.sendSubshellInput`) types into a
RUNNING pane over REST, gated at `edit` like terminal input on the attach
socket, through the one `NodeLauncher.sendInput` member: it writes no row, so
it is the deliberate exception beside the announce rule above (no `publishLive`,
no audit row), and `submit` appends Enter as a second frame, so the pair is
ordered but not atomic. RUNNING means the row's TWO facts: a self-exited pane
parks at `status: "running"` with `alive: 0` and its session already reaped, so
the guard reads `alive` beside `status`, or that window types into nothing and
answers 500 on a remote node (measured 2026-09-25). `POST /:id/restart` gained an optional `prompt` that
rides the successful revive through the SAME `deliverPrompt` seam create uses
(the settle constants are exported from the manager so there is one settle
policy), turning `promptDelivered` honest on the row restart always carried as
a truthful false.

**Local panes are launched with `remain-on-exit`, and the launcher owes them a
reap.** The option is what makes a finished pane observable (it is why a death
carries a real exit code), and its price is that tmux no longer tears itself
down, so `#applyDeath` kills the session for a row it is retiring. That reap is
gated on `LOCAL_NODE_ID` because the plane must not kill a server on a machine
it does not own; the node does its own in `reportDeath` (see
`apps/node/agent/AGENTS.md`), and between them every dead pane's server goes.
A liveness read must ask `#{pane_dead}` rather than `has-session` for the same
reason; a finished pane's session is still there.

**The pane-log capture child is `pane-log`, not `cat`.** `LocalLauncher.launch`
passes `probePaneLogLaunch().spec` (a `subshell-server`/`subshell` self-path +
the `pane-log` verb) to `pipePane`, which runs `@internal/pane-runtime`'s
`appendStdinToLogFile`, an unbuffered `readSync`→`writeSync` copy opening 0600.
The reason is the node's lag showing up here too: a bare `cat >>` froze the
live view on hosts whose `/usr/bin/cat` is uutils coreutils (it buffers a
partial write to a regular file, so a keystroke echo reached the log only on an
Enter-sized burst). `cat >>` remains only pipePane's no-child fallback for an
unresolved self-path. Full accounting: `docs/security.md`, "Pane logs".

**A node's reachability is an announcement too.** `nodeOffline` flips in
every broadcast row the moment a machine's socket drops, but no write
touches those rows, so `services/nodes/node-presence-announce.ts`
publishes `subshell.changed` for the RUNNING rows on connect, on
disconnect, and when a refused agent is held (why an agent that simply
dies would otherwise render healthy, and the SSE stream this replaced:
`apps/server/api/docs/ws-attach.md`).

The cost of that layering is drift, and it has bitten twice: the first
pass announced `createSubshell`'s ROLLBACK path and not its success path, so a
launch published nothing at all and every test stayed green; and the feed's
own switchover left `persistOutputFor`'s pre-existing `lastOutputAt` write
without an announce, so a printing pane read idle and its dot never blinked
(fixed 2026-09-25; `ws/__tests__/viewers-output-announce.test.ts` pins the
announce, and an agent node was the worst case: no sweep reaches it). **When you add a
subshell mutation, add its announce, and check it with a real client**; the
suite cannot see this. The reconnect snapshot is the only backstop.

Services own cross-repo logic; route handlers stay thin. Routes MAY use
`contextPlugin` (`src/plugins/context.plugin.ts`), which gives handlers `ctx`
(a per-request `ApiContext`: `db`, `log`, `repos`, `services`). The subshells,
workspaces, and channels routes are converted to `ctx.services.*` and live in
per-resource directories under `src/api/`; other routes still instantiate
repositories directly with the shared `db`. Code outside requests (the ws
handlers) reaches the same graph via `getRequestlessContext()`
(`src/lib/context.ts`), a singleton context whose log is the app logger
(no request id).

**Workspaces have a draft state** (spec 2026-09-14): `workspaces.draft` is 0/1 and
the per-user unique name index is PARTIAL (`WHERE draft = 0`), so an unsaved
workspace created by splitting a subshell may share a name freely. `GET /` hides
drafts; `?subshellId=` is the one read that returns them. `PUT /:id { draft: false }`
is the only transition, and removing a pane from a draft left with fewer than two
deletes the draft (`workspaceDeleted: true`). Migration `0029`'s `down` DELETES
drafts rather than renaming them; the pre-0029 schema cannot express one.

The pane's size with SEVERAL viewers attached is decided by
`shared-geometry.ts` in `@internal/subshell-protocol`: the browser has
to EXPLAIN the same decision the server APPLIES. Both attach paths
(`ws/subshell-ws.ts`, `ws/remote-subshell-ws.ts`) are the same shape:
subscribe to the shared pump BEFORE reading the pane (never overlap
per-subshell pumps), fit to `sharedGridFor()`, and the `geometry` frame
carries only a CONFIRMED grid: `paneSize()` answers a real grid or
`null`, never a guess; `resize` is a request, not a guarantee. The
viewer registry is keyed by `viewerId`, NEVER by socket identity
(Elysia hands `close` a different wrapper than `open`), and
`resetLiveViewersForTests()` must clear ALL of the module's
per-subshell state together.

**Working on the attach paths, the viewer registry or pane geometry:
read `apps/server/api/docs/ws-attach.md` first.**

**A node is refused by TWO gates, in this order** (`node-ws-handler.ts`):
the **version floor** first (`MIN_NODE_VERSION`, the gate an operator
can act on; it rides EVERY protocol bump, the same commit raising it and
`apps/node/agent/package.json` to one value; rule stated in full in
`versions.ts`), then **the protocol, matched EXACTLY** in either
direction: no compatibility window, no per-feature gating; the server
and the node ship together, so bump it whenever a frame changes,
additive or not, and release both. Since spec 2026-09-15 §5.3 a refusal
never CLOSES: `holdRefusedNode` parks the socket in
`node-registry.ts`'s `held` map: offline for every purpose but
`update`, the 4406 carrying the relayed reason coming only when the hold
ends. The identity is persisted BEFORE either gate. The two gates carry
distinct meanings and emit distinct refusals; never infer one from the
other (a node meeting both conditions hears the floor's). Chips,
roll-up, bump history: `apps/server/api/docs/node-gates.md`.

Neither gate touches geometry: `paneSize` answers the same way on a local and a
remote pane, so nothing downstream of the attach branches on where a pane runs.

### Terminal attach diagnostics

A garbled live terminal is diagnosed from the journal first: the
`geometry` and `painted` lines under `journalctl --user -u
subshell-server.service | grep "ws attach"` say which bundle is talking
and what the pane did before the capture. Three invariants on that path
are load-bearing and easy to regress: capture-text LF normalization
(`ws/capture-text.ts`; the live tail must NOT be normalized), the
gap-free OVERLAPPING join (a skipped byte desynchronizes a
diff-rendering TUI permanently; the overlap's visible transient is
deliberate damage control, and the zero-overlap "quiet join" was tried
and rolled back), and the replay's MISSING trailing terminator plus the
absolute-cursor restore (without it, every later relative-positioned
frame lands on the wrong rows). `SUBSHELL_ATTACH_DEBUG=1` dumps real
screen contents to world-readable files: off by default, never swept.

**Read `apps/server/api/docs/ws-attach.md` first: the full invariants,
the measurements, and which probe script verifies what.**

### Error contract

Every non-2xx response carries the structured body of
`ApiErrorResponseSchema` (`src/schema/error.type.ts`):
`{ errId, code, message, statusCode, reqId?, metadata? }`: `errId` is a nanoid;
`code` is a machine-readable `BackendErrorCodes` value (`@internal/backend-errors`).
Two paths produce it:

- A handler that **returns** `status(code, apiErrorBody({ code, message }))`
  (`src/lib/api-error.ts`), used by `uploads.route.ts` for expected 4xx.
- A thrown error mapped by the global `errorHandlerPlugin`
  (`src/plugins/error-handler.plugin.ts`), mounted first in `createApp()`:
  validation failures → 400 `INPUT_VALIDATION_ERROR`; `.status`-carrying errors
  (auth-guard classes, the service-local `*Error` throws) keep their status with
  a `code` derived from it; anything else → 500 with a generic message (internals
  never leak; outside production the body adds `stack`/`causedBy`).

Most converted routes take the **throw** path, not the return path. `errId`
appears on the wire for every error, but only **logged** errors (5xx and
explicit `throwApiError`) also emit a server log line carrying it; expected 4xx
are `doNotLog` and are deliberately not written to the log. `reqId` is declared
in the schema but only populated once request-scoped logging attaches it.

## The server manages itself on an admin's request

Spec 2026-09-12 moved server-UP management out of the Subshell Server
desktop console into the SPA, so a browser on the LAN and a headless
install get it too, which meant it had to become HTTP. The routes live
in `api/admin-server/`, composed into the `adminRoutes` group, every one
behind `requireAdmin` (cookie session, admin role, bearer keys refused),
exactly like `GET /api/admin/status`:

| route | |
| --- | --- |
| `GET /api/admin/server` | how this server is DEPLOYED, as against `admin/status`'s what-is-HAPPENING; `TRUSTED_ORIGINS` is the exception: read live, so `saved === running` always |
| `PATCH /api/admin/server/config` | rewrite config.env through the CLI's own writer (see `apps/server/api/docs/config-env.md`). `DATABASE_PATH` is deliberately absent |
| `POST /api/admin/server/restart` | exit for the service manager to respawn; refused unless the manager reports THIS pid, or the definition keeps live panes / `force` |
| `POST /api/admin/server/autostart` | arm or disarm start-at-login; touches nothing about the running process (inside the no-route rule, not an exception to it) |
| `GET /api/admin/server/logs` | the tail of the server's own log file |
| `PUT /api/admin/server/logging` | the debug switch, applied live |

What did NOT become a route is the corollary of the same rule: stop, start,
install, uninstall and reset each leave the server unreachable, so a page
cannot be the thing that performs them. They stay with `subshell-server
service <verb>` for the headless operator and the desktop assistant for the
other one.

`GET /api/admin/server` carries no secret in any form, and its test asserts the
response's ENTIRE key set, the same rule `GET /api/settings/instance` carries,
so a field added later is a decision rather than an accumulation.

- **`settingSource` asks "would writing the file take effect", never
  "is it in `process.env`"**. On systemd the unit's `EnvironmentFile=`
  exports every key at start, so a presence check would read the whole
  file as environment-owned and 409 every PATCH. Env-ownership is
  decided ONCE, at construction, and cannot be re-asked after a write.
- **`TRUSTED_ORIGINS` is re-read from the file on write**
  (`originRegistry().reloadStored()`), so a changed origin takes effect
  with no restart; `process.env` is mirrored from the file only when the
  loader had put it there.
- **`isSupervised` is the manager's pid versus `process.pid`, never an
  environment marker.** `performRestart` closes browser-terminal and
  node sockets with 1012 (chosen for being below 4000: the SPA retries
  those) and exits after its 202 flushes; the 202 carries `resumeAt`.
- **The log file's directory is created on FIRST WRITE**, keeping the
  entry graph import-pure, and the writer is `CappedFileTransport` (a
  measured rejection of the rotation package; "replaced when full" means
  truncated). The debug switch flips only the FILE transport's level:
  stdout stays `info`, HTTP request lines ride `debug`, polled routes
  excluded. The one exception is `--verbose` (2026-09-26): it raises
  THE CONSOLE transport to debug for the life of a hand-invoked run
  (`setConsoleVerbose` in `utils/logger.ts`, the deliberate mirror of
  `applyDebugLogging` that never touches the FILE gate, the settings
  row, or the env-forced read-only rule), and it is refused together
  with `--json` where a command emits JSON.
- **Node refusals map by EQUALITY** of `NodeRpcError.detail` against the
  protocol's `NODE_RESULT_*` constants (never a substring of `message`),
  and only an answered `"kills"` earns the certain sentence: `unknown`
  and the no-report `undefined` both belong on the hedge side, on the
  node routes and on the server's own `restart`/`update` alike.
- **`NODE_INVENTORY_REFRESH_MS` is DERIVED as `INVENTORY_TTL_MS / 2`**,
  no stagger: a longer period would leave an online node reading as
  unusable for the tail of every cycle, and a skipped pass must still
  leave the cache fresh.

**Working on the admin-server routes, the log file, node management or
inventory refresh: read `apps/server/api/docs/self-management.md`
first.**

## Standalone binary & CLI

`src/index.ts` is BOTH the boot entry and the `subshell-server` CLI entry:
`bun build --compile` of it yields a self-contained binary: no bun, no repo
checkout on the host, and the built SPA **embedded** (see
`apps/server/api/docs/cli.md`). The boot
contract is untouched: no subcommand, or a leading flag, IS the boot path, so
a systemd unit whose `ExecStart` names the binary (or `bun <entry>`) with no
subcommand boots the server exactly as before (spec 2026-09-03). That form
predates the CLI (it is what the removed `svc.sh` wrote), and the tests pin
it, so never make a bare invocation mean anything else.

The verbs, hand-rolled dispatch in `src/cli.ts`, no flag library. The
full table (every flag, refusal and exit-code contract) is in
`apps/server/api/docs/cli.md`: `version`; `status [--json]` (read-only
view, never boots); `init` (first run, THE headless entry point; the
desktop app passes `--no-service`); `configure`; `service install |
uninstall | enable | disable | status | start | stop | restart`;
`update` (the reversible transaction, see "Updating the server" below);
`backup`; `mcp` (the one long-running verb, spawned by harnesses);
`report attention …` / `report session` (generated harness-hook lines,
never typed; ALWAYS exits 0).

An unknown word exits 1 with usage. **Sync-exit design** (house style for
the quick commands, no longer the safety mechanism): a handled command
should run to completion and `process.exit` SYNCHRONOUSLY inside
`dispatchCli` (sync fs, `Bun.spawnSync` for the service manager). There are
now FIVE exceptions rather than one: `mcp`, long-running by design and
suspended in its stdio loop; `init` and `configure`, which became async
when their prompts moved to `@clack/prompts` (spec 2026-09-15), since a promise-based
library cannot be driven by `readSync(0, …)`; and `update` and `backup` (spec
2026-09-15 §4.1/§4.4), which download, prompt and `VACUUM INTO` a database.
`update` is the third named exception in the sense that matters; it is the one
that both prompts AND does network I/O, and it can sit for up to 60 seconds
waiting for the restarted binary to finish or revert the transaction.

That is allowed precisely BECAUSE sync-exit is not the safety mechanism, and
the two things that are stay intact and tested: the entry graph is IO-free at
import, and `isCliEngaged()` flips synchronously at subcommand recognition, so
a suspended command cannot boot the server underneath it.

What makes ANY suspension safe is not the exit style but two tested
invariants: the entry graph is IO-free AT IMPORT (lazy `getAuth()`; no
module opens SQLite or binds a port merely by being evaluated, pinned by
the import-purity tests), and the `isCliEngaged()` boot gate in
`index.ts`, flipped synchronously at subcommand recognition, is what
keeps a suspended (or sync) command from booting the server underneath
it. (Historical: on bun 1.4.0, measured not spec, ANY await in the entry
prelude lets the rest of the entry graph and the boot body evaluate; the
littering that once made sync-exit load-bearing (`@/auth.js` building
better-auth, and opening its SQLite file, eagerly at import) is gone
with the lazy construction, so the boot gate now carries that load.)

### Boot output

Boot opens with the `/subshell` wordmark, then `subshell-server
<version>`. The banner is hand-set ASCII (a mark REDRAWN for the grid,
not a resampled one; the `#`/`+` split draws the same two-tone boundary
the colours do, pinned together by a test) and 24-bit colour is emitted
only when stdout is a TTY. Full rationale:
`apps/server/api/docs/cli.md`.

### config.env (`src/config-env.ts`)

`~/.config/subshell-server/config.env` (dir 0700, file 0600, temp +
rename; home from `SUBSHELL_SERVER_CONFIG_DIR`). `constants.ts` itself
applies it with SETDEFAULT semantics at the top of its own module body,
BEFORE dotenvx, NOT in `cli-bootstrap.ts` (measured: the bootstrap's
body runs after the whole import graph), so precedence is **process env
> config.env > `.env` > built-in defaults**, and `bun run dev` honours
the developer's own config.env (`e2e/stack.ts` overrides the home to
keep stock config). **`applyConfig` is the ONE writer**, called by
`runConfigure` and by `PATCH /api/admin/server/config` alike: the shared
CALL is the guarantee, and validation runs twice (per-prompt, then
whole-set) from one rule set. `configure` owns five keys
(`SERVER_PORT`, `HOST`, `APP_BASE_URL`, `DATABASE_PATH`,
`TRUSTED_ORIGINS`); defaults follow the FILE in every mode, `--yes`
included. `TRUSTED_ORIGINS` is the OPERATOR's extras, written or
REMOVED, never written empty, canonicalized to `URL.origin`, wildcards
REFUSED. Why `status` carries per-entry diagnostics instead of boot, and
"Wildcards are the deliberate silence" there; the LAN probe and the
plugin-record derivation: `apps/server/api/docs/config-env.md`. `init`,
`configure` and `service install` refuse when tmux is absent
(`SUBSHELL_SERVER_SKIP_TMUX_CHECK=1`). Interactive runs first OFFER to
install it, and since the operator ruling of 2026-09-26 `--yes` IS the yes:
`init`/`configure` RUN the installer directly. `service install` takes no
`--yes`, so its gate stays TTY-only. A refusal nobody was asked to decline
(now: a run with no terminal AND no `--yes`) prints one more line naming
that remedy. The same ruling's second half: the preflight runs FIRST in
`init`, and a DECLINED offer or a failed installer child ABORTS the command
at exit 1 before anything is written (a config home for a server that cannot
run panes is half a setup); the abort message names the declined manager's
manual command, notes the binary is already installed, and gives the rerun.
The macOS ladder is three-way (2026-09-26): `brew`, then MacPorts (`port`),
and with neither an offer to install Homebrew itself through Homebrew's own
documented installer (their infra, not ours; it prompts for an admin
password, so a run without any terminal gets loud instructions instead of an
attempt). `init` also acquired its own terminal first: a piped run
attaches the controlling terminal with a never-blocking open, and the
defaults a truly non-interactive run takes (no service, no tmux, PATH
instructions) are all PRINTED, because silence was the bug this closed.

**Working on config.env, `applyConfig`, the origin registry or `status`
diagnostics: read `apps/server/api/docs/config-env.md` first.**

### Service supervision (`src/service.ts`)

`KillMode=process` on the systemd unit is the load-bearing line: each
local subshell's tmux server is a CHILD of the unit, so the default
control-group kill SIGKILLs every live pane on stop/restart. The
EFFECTIVE value is ASKED of systemd (drop-ins are invisible to a
unit-file grep) and both destructive verbs fail CLOSED on an unreadable
definition: `unknown` is not evidence of safety. On macOS "starts at
login" is the **plist's LOCATION**, not a key inside it (both
flag-shaped alternatives were measured and rejected). On Linux `enabled`
and `linger` are two independent facts, and without `loginctl
enable-linger` a headless box never starts the unit at all; the probe is
by UID and its answer-mapping is SHARED with the node's twin via
`@internal/subshell-protocol`, the one sanctioned exception to the
ports-are-duplicates rule.

**Working on the unit/plist templates, `queryService`, or autostart:
read `apps/server/api/docs/service-units.md` first.**

### MCP entrypoint resolution

The pure ladder in `src/services/mcp-resolve.ts`:
`SUBSHELL_MCP_COMMAND`/`_ARGS` override → SELF (the server binary IS the
MCP server) → the `subshell` node CLI on PATH → throw naming the
override. A deployment matching none 500s on create;
`subshell-server status` prints the resolved rung so the gap shows
before a user hits it. The harness-hook reporter shares the ladder MINUS
the override (that variable names an MCP server, which may point at a
wrapper with no `report` verb), and on an agent node is composed from
that node's reported `selfInvoke` prefix: a hook runs where the pane
runs. Rationale and the retired `bun -e` hooks:
`apps/server/api/docs/cli.md`.

### Updating the server (spec 2026-09-15 §4)

Whoever SWAPS writes the marker (`<dataDir>/update/pending.json`, 0600,
and keeps the old binary as `.previous`); whoever BOOTS completes or
reverts the transaction (migrations pass → audit, delete both; migration
fails → restore the DB backup, rename `.previous` back, record, exit 1;
and the landing boot RE-CREATES the update tracker's server entry from the
marker, since the in-memory begin died with the swapping process),
which is what makes the CLI, dashboard and desktop paths ONE
implementation. The four modules, and the one fact each exists for
(`installed-binary.ts`: the binary the SERVICE DEFINITION names, never a
path by convention; `db-backup.ts`: the one-JSON-line contract), the
three measurements the design rests on (live-WAL `VACUUM INTO`; rename
over a RUNNING binary; Kysely refusing unknown migrations, which is why
a revert restores the backup and not just the binary), and the `test:cli`
`server-update.sh` proof: **read
`apps/server/api/docs/updating.md` first.**

### Embedded SPA + release dance

`selectStaticPlugin`: an on-disk frontend dist wins, else the SPA baked
into the binary (memory mode answers with a strong `ETag`), else boot
fails loudly; on the build machine the compiled binary's BUILD-TIME
`import.meta.url` lets the repo's own `apps/server/web/dist` shadow the
embedded copy (`staticSource()` is the diagnostic). The
`release:cli-server` dance: `apps/server/api/docs/cli.md`; the CI side:
root `docs/release-and-ci.md`.

## Testing

`bun test` only (vitest was removed; its node worker cannot import
`bun:sqlite`). `bunfig.toml` preloads `src/test-preload.ts`, which sets
`SUBSHELL_TEST_MODE`; `src/constants.ts` turns that into a **per-process
temp-file database** (`$TMPDIR/subshell-test-<pid>-<uuid>.db`, unlinked on exit;
one path string per process, so the app's Kysely connection and better-auth's
handle share one DB, and concurrent `bun test` invocations cannot contend)
and a throwaway log directory. `NODE_ARTIFACTS_DIR` derives from that temp
data dir under the test env, which is how the download-route tests write
fixtures straight in. All test files within one invocation share
that DB, so suites must not assume it starts empty. Tests never touch
`data/`.

**A run reaps its own tmux servers**: the `test` script prefixes
`TMUX_TMPDIR=$(mktemp -d /tmp/subshell-test-tmux-XXXXXX)` and the
preload's `afterAll` `kill-server`s exactly what that directory lists,
so a concurrent run's panes are outside it. A bare hand-typed `bun test`
sets no such variable and gets no net, which is correct, since it also
gets the shared default socket dir, where killing anything would reach panes
the run never started. The net covers THIS package only;
`packages/pane-runtime` and `apps/node/agent` stand on each suite's own
register-before-spawn `afterAll`. The `--timeout 30000` in the script is
measured: this package's DB + better-auth setup against the shared temp
DB is what blows bun's 5 s default under CI load, not the tests. Why
each is shaped this way (the leaked-harness incident, where the variable
may and may not be set, the CI run numbers):
`apps/server/api/docs/testing-notes.md`.

**A new column on a shared table must also join the HAND-CURATED migration
lists** in the service/repository test files. `subshell-manager*.test.ts`,
`notify.service.test.ts`, and several `db/repositories/__tests__/` files open
their OWN `:memory:` database and apply an explicit list of migrations (the
anchor line is `pushUrgencyMigration.up(db)` in most of them); they do NOT run
`runMigrations()`. Adding a column that `SubshellsRepository.create` writes
without applying the new migration there turns every create in ~11 suites into
"no such column". The failure only appears in the FULL-suite run, because a
lone curated file also misses tables unrelated to your change (the same
`no such table: node_allowed_dirs` that makes some suites red when run alone
predates any of this). Follow the `0039-subshell-cross-agent` precedent: append
the new migration's `.up()` beside the curated anchors.

Route tests live in `__tests__/` next to the route and share
`src/api/__tests__/helpers/auth-tables.ts`:

- `setupAuthTables()`: runs the real app + better-auth migrations once per suite
- `signIn(email, password)` / `authedRequest(...)`: real session cookies
- `deleteUserByEmailOrId(...)`: per-test cleanup

Migrations must be applied by the code under test or the helper, never
assumed from a developer's local `data/subshell.db`.

**`test` must keep turbo's `dependsOn: ["^build"]`**; do not narrow it
for a faster loop: `__tests__/cli-entry.test.ts` spawns a REAL
subprocess that re-resolves workspace packages from disk, and a
concurrent dependency build momentarily blanks their `dist` (the full
incident: `apps/server/api/docs/testing-notes.md`).

Separately, the repo-root `e2e/` suite drives this server as a real subprocess
(`bun src/index.ts` with `NODE_ENV=development` against a temp-file DB and a
stub `pi` harness on port 3199), a full-stack check that is deliberately
outside `bun test`. It is launched by `bun run test:e2e`, never by `turbo test`.
