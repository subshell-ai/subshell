# Server AGENTS.md

Server-specific documentation for the ElysiaJS API server (`apps/server/api`, `@internal/server`).

## URLs

- API server: http://localhost:3080 (`SERVER_PORT`/`HOST` env, see `src/constants.ts`)
- OpenAPI docs (Scalar): http://localhost:3080/docs
- Local OpenAPI schema: `/openapi.json` (`/docs/json` redirects there)
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
`SUBSHELL_EMERGENCY_PASSWORD` (the break-glass rule is under "Authentication"
in this file).

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

`api/__tests__/api-surface-auth.test.ts` checks the composed main router:
every route must inherit the shared authentication and scoped-key permission
hooks or appear in its explicit exception inventory. It also pins the admin
route families and probes anonymous and node-key requests. Keep a new public
or conditionally authenticated route's credential boundary in that inventory.

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

The nodes READ surface widened twice: spec 2026-09-25 (MCP DX) made `GET
/api/nodes` answer a bearer machine token with its owner's own nodes
(owner-only, no shares, no admin boost, disclosure-only), the door the MCP
`list_nodes` tool rides; 2026-10-09 gave the COOKIE list its admin arm: an
admin sees every machine node (`findAllMachines`), matching the detail gate
that already gave admins `edit` on foreign rows, while a non-admin's list is
the unchanged owner/share filter. Node setup-key management, detail reads, and configuration also accept system
keys with the specific `systemPermission` declared by each route. New keys carry
versioned explicit grants; authGuard denies unannotated routes by default. The shared
`nodeManagementGuard` denies legacy keys and subshell tokens; `loadNodeGate`
limits bearer access to owned agent nodes, without shares or the local host.
Node lifecycle, server-address changes, and machine trust repair routes stay cookie-only. Setup-key
creation still honors the enrollment setting. The accounting is `docs/security.md` §3 and the pins are
`api/nodes/__tests__/nodes-list-bearer.test.ts` plus the admin-arm cell in
`nodes-crud-route.test.ts`.

The Nodes plane serves the prebuilt `subshell` binaries from
`NODE_ARTIFACTS_DIR` at `GET /api/downloads/node/*` (cookie,
unconsumed setup key, or a still-valid one-time `?update_token=`; never
anonymous), and fetches the binary LAZILY from the project's own
`cli-node-v*` GitHub release when that is the answer, downloading it in full
and hashing the whole file against the SIGNED manifest's `assets` map before
any byte is served (the 2026-10-23 fan-out fix: an in-flight fetch is
shared, and a shared one-shot stream handed every joiner but the first an
empty body). Which release a
node is OFFERED (`NODE_PROTOCOL_VERSION` matching), the three-way refusal
grammar, the shelf-reconciled versus release-coherent serving (spec
2026-10-09: the copy is asked what it is before it wins), and the surfaces
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

**Plugins & installers: the security half.** Plugin shape and runtime facts
(loaded from disk, `PluginHost`-only, JSON identity in `package.json`, static
built-ins + the one sanctioned `await import()` in `plugin-runtime.ts`,
plane-built argv) live in the root **`AGENTS.md` ("Plugins are packages…")**;
that section is the source. The security half (moved here from the security
summary; it was auto-loaded everywhere and belongs to these routes):

- **The control plane owns which plugins exist** (§6, §11.9): one store, `<SUBSHELL_SERVER_DATA_DIR>/plugins/`; one install arms every node. A node holds no plugin concept. `/api/plugins` writes are **cookie-admin only** (bearer refused): installing runs third-party code unsandboxed in the process that holds the node signing keypair, so a malicious plugin reaches every enrolled node (§11.9); audited `plugin.install|enable|disable|uninstall|unpublish`. The anonymous setup route stays built-in-ids-only forever (its body carries no `spec` field).
- Registry install (`POST /api/plugins` with a package spec): sha512 over the raw bytes against the announced hash before anything is written; the extractor refuses links/traversal/oversize; the load-check runs on a staging copy; a refused install leaves the previous state byte-identical; **any package name is installable** (deliberate, decided against an allowlist); `SUBSHELL_PLUGIN_REGISTRY_URL` is operator-configurable. Over an http mirror, integrity proves only that bytes match what THAT server published. A claimed-id collision is refused BEFORE the module runs (`assertIdClaim`), re-checked immediately before the swap against a concurrent install; a registry package claiming a built-in id is never loaded.
- `GET /api/plugins/:pluginId/icon` serves plugin-chosen bytes to any authenticated reader: Content-Type from the extension, never sniffed; the resolved path re-checked under the plugin's own dir; `CSP: default-src 'none'; sandbox` + `nosniff`. Keep all three.
- **Agent CLI install** `POST /api/setup/agents/:id/install`: admin cookie only, never public (not in the no-users window); the id is the only input; the command comes from a BUILT-IN manifest; single-flight per id; 10-minute bound; audited `agent.install` WITHOUT output (returned to the admin's browser, never logged); the child's env is the allowlist, not the server's.
- **tmux install** `POST /api/setup/tmux/install`: admin cookie only (stricter than its `/api/setup` neighbours: it runs code); NO operator input; argv from a compiled-in table; **anything `sudo`-prefixed refused 409 before anything runs** (every Linux entry is sudo-prefixed, pinned by test; in practice macOS/Homebrew only); audited `tmux.install`.
- **Shared spawn-core bounds** (§11.10, §11.13): the `CHILD_ENV_KEYS` allowlist (no `BETTER_AUTH_SECRET`, no database path) with two wrinkles: every `LC_*` variable passes through, and a caller's/plugin's `extra` may add variables but **never PATH**; stdin is closed **unless the plugin supplies `opts.stdin`** (a sudo prompt goes to the child's own tty, not a server-held pipe); the 64 KiB output cap is **PER STREAM** (stdout and stderr each); a 30 s default deadline capped at ten minutes.
- Instance plugin secrets: **designed, NOT built**: `SUBSHELL_SECRETS_KEY` env-only (never a settings row, never the DB), write-only over the API, fails closed when unset, a lost key unrecoverable. Pane-side credentials stay in the node's own environment, which the plane never sees.
- **Harness self-report is exactly four own-key surfaces**: `POST /api/subshells/:id/attention`, `/:id/harness-session`, `/:id/subagents/report`, `/:id/exit` (the route checks `principal === sess:<id>`), plus the token self-extension route. Subagent reports carry roster facts and harness-authored one-line task labels only, never prompts or transcripts; reported names and labels take the `normalizeLabel` NAME path at the boundary (they render for every viewer), while id fields carry length bounds, not normalization. A harness reports about itself, never another subshell; a forged session id merely selects a transcript the pane's own user could already read.
- **Beyond its row** (§4): raw REST resolves a pane's token as its OWNER with boost and shares off, so a prompt-injected pane can create, restart and **terminate** the owner's OTHER subshells (the sibling-action surface the "other panes are agents" posture rests on, accepted at the harness's own altitude (§11)).
- `/api/files/explore` **403s machine credentials**. `SUBSHELL_FS_ROOT` unset = the host filesystem is browsable by design; the check is lexical AND realpath, unresolvable paths refused; it never confines a remote node.

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

**Workspaces are work-first, drafts are gone** (spec 2026-10-17, migration
`0058`): every workspace row is a real, named one, names are NOT unique
(the old partial unique index `WHERE draft = 0` is dropped; 0058's `down`
dedupes names by rowid on rollback). Removing the final pane RETIRES the
workspace (ruling 2026-10-20 conforms the remove side to the close side): the
delete is one statement scoped to the workspace, so a concurrently-removed
pane still answers 404, and the retire reuses `retireEmptyAmong` and its own
NOT EXISTS guard against a racing add. The subshell itself keeps running,
unfiled. Deleting a subshell can still retire its emptied workspaces. That delete reads the owner's
workspace ids HOLDING that subshell first (`idsHoldingForUser`), then retires
only the candidates the cascade actually left pane-less (`retireEmptyAmong`).
An intentionally-empty workspace survives an unrelated tab closing, and other
owners' emptied workspaces are a fact about THEIR arrangement, untouched. `workspace_panes` is UNIQUE on
`(workspace_id, subshell_id)` (0058 dedupes by oldest `created_at` first), so
`addWorkspacePane` is idempotent: the second add returns the existing row with
`alreadyPresent: true`, never a 409, and the UNIQUE race between two adds
re-reads. `GET /` carries every workspace of the caller's WITH its panes (the
rail tree reads the LIST, not per-workspace GETs); the one opt-in read left is
`?subshellId=` (workspaces holding that subshell). `POST /api/subshells`
accepts an optional `workspaceId`, gated as the resolved owner's workspace
(404 on any miss, ownership never reading 403); the pane insert rides the
create and is undone with the subshell row if it fails.

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
never CLOSES: the socket is parked in `node-registry.ts`'s `held` map
(`holdRefusedNode` on the `ready` path, or the handshake binding itself
since spec 2026-10-13): offline for every purpose but
`update`, the 4406 carrying the relayed reason coming with the IDLE close
(the other ways a hold ends carry their own codes: a superseding socket
4409, revocation and disable their refusal codes). The identity is
persisted BEFORE either gate (the binding path
writes no new facts: a held row shows its last honest `ready`, or the
fallbacks). The two gates carry
distinct meanings and emit distinct refusals; never infer one from the
other; the floor's sentence still wins on the ready path, but a PINNED
dial meeting both conditions hears the PROTOCOL one, because the binding
decides the protocol before any version gate can run. Chips,
roll-up, bump history, the binding-arm ruling:
`apps/server/api/docs/node-gates.md`.

Neither gate touches geometry: `paneSize` answers the same way on a local and a
remote pane, so nothing downstream of the attach branches on where a pane runs.

### Terminal attach diagnostics

A garbled live terminal is diagnosed from the journal first: the
`geometry` and `painted` lines under `journalctl --user -u
subshell-server.service | grep "ws attach"` say which bundle is talking
and what the pane did before the capture. Four invariants on that path
are load-bearing and easy to regress: capture-text LF normalization
(`ws/capture-text.ts`; the live tail must NOT be normalized), the
gap-free OVERLAPPING join (a skipped byte desynchronizes a
diff-rendering TUI permanently; the overlap's visible transient is
deliberate damage control, and the zero-overlap "quiet join" was tried
and rolled back), the replay's MISSING trailing terminator plus the
absolute-cursor restore (without it, every later relative-positioned
frame lands on the wrong rows), and the mode statement every capture
LEADS with (the pane app's alt-screen/mouse DECSETs, authoritative h/l
per live tmux flags; `""` means UNKNOWN, never "all off";
`TmuxRunner.paneModePreamble`). `SUBSHELL_ATTACH_DEBUG=1` dumps real
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

## Nodes: the plane-side rules

Node mechanics depth (link close codes and pin lifecycle, §6; setup-key
revocation; allowlist enforcement layers; artifact serving;
lazy-release-fetch order; dashboard guard internals, §5/§6/§11.12; the
agent's own behavior in `apps/node/agent/AGENTS.md` and its `docs/`) lives
there; the plane-side serving and gates accounts are `docs/node-artifacts.md`
and `docs/node-gates.md` above. Read it before designing node work. The
agent-side halves of the rules below (the ratchet and pin behavior on the
link, the maintenance mirror check, the service-control executor posture, the
`subshell configure` CLI verbs, and the node's loopback dashboard) live in
`apps/node/agent/AGENTS.md`. (Moved here from the security summary, which
auto-loads into every session; "§N" references below point into
`docs/security.md`.) The rules that must stay in a plane-side editor's head:

- Enrolling **delegates arbitrary command execution under that machine's OS user**; the node's OS user owns every pane, file, and `ps`-visible bearer token launched there. Never resilience to control-plane compromise (`<dataDir>/node-signing.json`, 0600; the link keypair `node-encryption.json` beside it, generate-once, fail-closed, is accounted in `apps/node/agent/AGENTS.md` and `docs/node-artifacts.md`).
- **The `/ws/node` link is app-layer encrypted since protocol 14** (§6): `crypto_kx` against the pinned statics, then `secretstream` only; the ratchet never resyncs: a bad frame is close `4410` and a redial, never a repair, never plaintext fallback; `4411` is the ONLY pre-establishment close on which the agent drops its control pin. Replacing the PLANE keypair is NOT self-healed (manual per-node rotate + `subshell configure --key` + restart). Command signing (JWS, per node, short-lived, single-use) proves authenticity/freshness/target, never confidentiality; the two defenses stay independent by design (spec 2026-09-24 §9). The agent-side half of this bullet is duplicated in `apps/node/agent/AGENTS.md`.
- **Directory allowlist** (`PUT /api/nodes/:id/allowed-dirs`): **empty = unrestricted**, never deny-all; owner-only to edit (an `edit` grantee able to widen would face no restriction); enforced on the plane (create AND restart) and independently on the node (deliberately **fail-open on an unreadable file**, the plane's copy still enforces; the node's local read: `apps/node/agent/AGENTS.md`); browsing is NOT gated (the picker filter is UX); audited.
- **Share axes:** any node share, even `view`, lets the grantee launch their OWN subshells there (invisible to the node's owner unless separately shared); `edit`/owner configures; shares, rename, maintenance, the allowlist, stop/uninstall and repointing stay owner-only (admin for `local`). Node shares and subshell shares are independent axes.
- **Retire vs manage (two node gates, ruling 2026-10-09):** DELETE and RE-REGISTER are the retire gate `canRetire` = owner OR any admin (the #351 admin list shows every machine; a page that can't retire one reads broken). Everything else owner-only is the NARROWER `canManage` gate = owner (admin on `local`): shares, rename, maintenance, allowlist, key rotation. Retiring your view of a machine is weaker than deciding who else uses it, so the admin holds the first and not the second. An admin's recovery key is stored under the node's OWNER (redemption requires it); the admin is the audited actor.
- **`local` launch is granted, never boosted:** `nodeCanLaunchOn` reads the GRANTED access (admins included: the boost confers management, never launch). Narrowing = removing the seeded Everyone/`edit` row, which boot never "repairs"; the refusal is a 403 (remedy: a share), not the 404 of an invisible node.
- **Maintenance is a routing preference, never a quarantine:** enrolled, answers everything, takes no new subshells; turning it ON **terminates every subshell running there**, whoever owns them; retroactive by design, and affected owners learn by push. Owner-only (admin on `local`): the re-share gate `canManage`, NOT `nodeCanConfigure` and NOT the wider `canRetire` gate delete/re-register sit on (the machine's own `subshell maintenance on|off` sets the same flag, newer stamp wins and ties go to the plane, so the node's mirror check is defence in depth, not a second switch: `apps/node/agent/AGENTS.md`). Containment is deleting the node, rotating its key, or clearing shares. Deletion and rotation remain cookie-gated; clearing shares also accepts an enabled system key for its own agent nodes. Audited.
- **Service control** (signed command; cookie only, owner or `edit`, `local` refused, audited `{verb, forced}`): the agent refuses unless the manager reports this very pid, and when the definition would take its panes down without `force` (the executor posture: `apps/node/agent/AGENTS.md`); **`stop`/`uninstall` are owner-only and structurally one-way** (they end the socket that would carry the undo); `force` is refused outright on `start`/`install`.
- **Repointing** (signed `set_server_url`) is **owner-only and a real widening**: the machine dials the named host with the node key, valid on THIS plane; loopback refused outright; addresses validated by component, stored canonicalized; audited naming the NEW value only; the running daemon hot-reloads it and re-dials on its next heartbeat beat (~15 s, no restart; the disclosure lands on the click, not a future boot).
- **Disclosure surfaces:** the runtime report (supervision, paths, tmux) attaches only for an ONLINE agent node, viewer owner or `edit`, never `local`, never `view`. `ready` discloses host facts (agentVersion, os/arch, hostname, dataDir, capabilities, selfInvoke prefix, homeDir); `detect` answers ONLY the binaries/env names the plane asked (union of `subshell.hostEnv` across enabled manifests), never scans, so a plugin install (admin) decides what env names every node may be asked. `held` is disclosed to every viewer; `runtime` is not. A node view carries `ownerLabel` (whose machine) ONLY to a cookie-admin, the `?all=1` setup-key precedent (ruling 2026-10-10); every other viewer's payload lacks the field. Daemon log over HTTP (owner/`edit`) never carries pane content or argv. `PUT /api/nodes/:id/logging` (an `edit` act for browser sessions, or an enabled system key on its own agent node; `local` refused) is refused while `SUBSHELL_DEBUG_LOGGING` forces it on: a write the next read would mask is not a success.
- **Refused agents are HELD, not closed** (§11.12): offline for every purpose but `update` (frames dropped after envelope parse, before dispatch); the `update` command's wire shape is FROZEN across protocol bumps for this; since spec 2026-10-13 a pinned wrong-protocol agent is held FROM THE BINDING (link established, `update` sealed) instead of refused 4410, same posture, reachable from protocol 14 up. (The gates' own mechanics: `docs/node-gates.md` above.)
- **Re-registration keys**: cookie retire-gated (owner or any admin, `canRetire`) on agent nodes; the mint is stored under the node's owner so redemption's ownership check holds; `POST /api/nodes/:id/reregister` mints a single-use 24 h setup key bound to the existing row. Redemption through enroll preserves node relationships and settings, atomically swaps credentials and public identities, revokes the old bearer and unused sibling recovery keys, and evicts live/held links. Minting disconnects nothing. Deleting the target cascades recovery keys. Recovery adds no row, so `allow_node_enrollment` gates only new-node keys. Audits `node.reregister_key|reregister` carry ids, never secrets.
- **Setup keys**: single-use, 24 h, plaintext-stored to the key's OWNER only (the future node owner; for an admin-minted recovery key that is the node's owner, not the admin who triggered the mint) (browser sessions or explicitly enabled system keys for their own keys; other machine tokens get 403); `setup_key.create` carries no metadata: the key text never enters the trail. Admin may revoke ANY row (`setup_key.revoke`, `{foreign: true}` metadata), `?all=1` is admin-only (deliberate 403, never a silently-narrowed list). The node names itself (`--name`, `SUBSHELL_NODE_NAME`; `enroll` requires it) via `normalizeNodeName`, the same rule rename applies; a RECOVERY redemption validates the supplied name but does not apply it, the existing row keeps its own. Minting is gated by `allow_node_enrollment` (absent = TRUE; enforced at the mint ONLY (the key IS the credential); bounds the future, never revokes what is outstanding). `GET /install.sh` renders identically for absent/unknown/spent/expired keys (never a binary oracle); a VALID key bound to an existing node additionally names the node it re-registers and pre-supplies the wizard's name answer (the recovery path ignores any name; the row keeps its own), which discriminates between two LIVE keys only, and either one's holder can already redeem to control the node; enroll answers three distinct 401s by design. The key rides the install URL → shell history and access logs: the accepted posture of enrollment links.
- **Agent artifacts are never anonymous**: cookie, or valid unconsumed setup key, or one-time `?update_token=` (unlocks exactly one file at one digest; never reaches the `.sha256` routes). `install.sh`'s `server=<origin>` must be exact membership of the live trusted-origin registry; the rendered script digest-verifies before the first `chmod +x`.
- **Lazy release fetch**: every release-source fetch passes `releaseFetchAllowed` (configured origin ∪ GitHub release hosts; refused **by name before any connection**, egress destination pinned); no binary bytes until a machine is served (since 2026-10-09 the tiny index/manifest reads behind the serve decision run per authenticated download, TTL-cached with a one-minute failure backoff); hashed against the digest from the **signed manifest's `assets` map** (sidecar never fetched); bounded by `MAX_ARTIFACT_BYTES` (300 MB); only manifests declaring THIS `NODE_PROTOCOL_VERSION` are offered; only files this instance fetched (`.fetched.json`) are ever superseded or deleted; the shelf is reconciled AT SERVE TIME (2026-10-09: the copy is run `<file> version`, the newest server-supportable build wins, a hand-published copy speaking this protocol with a higher semver stays truth, a wrong-protocol copy 404s instead of installing a never-connectable agent, and `.sha256` announces the SAME decision the installer's skip depends on), an update download is served release-coherently else 409 naming the remedy. Empty `SUBSHELL_RELEASE_URL` = air-gapped (the shelf is the only source and answers for itself the same way: connectable and self-consistent, or refused). (Serving mechanics and the full account: `docs/node-artifacts.md` above.)

## Network plugins

A network plugin connects the control plane's host to one network and
publishes Subshell on it; the plugin-shape account is the root `AGENTS.md`
("Plugins are packages…") and the full accounting is `docs/security.md`
§11.13. The rules (moved here from the security summary; two clauses in
here, the `/api/network/*` gate and `canonicalPluginOrigin`'s failure
direction, appear in no other doc):

- **A network plugin DESCRIBES, the host EXECUTES** (§11.13): it returns argv, parses output, names a secret; never spawns, writes a file, touches config.env, or reads a credential back, every effect goes through a `PluginHost` member. `/api/network/*` is cookie-admin only, bearer refused, **never public** (no no-users carve-out).
- **The sudo boundary is absolute**: `host.run` throws on a non-absolute `argv[0]` or one basenamed `sudo`/`doas`/`pkexec`; the manifest parser refuses those words at ANY shell boundary (`&&`, `||`, `;`, `|`, `&`, newline; the route runs the line through `sh -c`, so a start-anchored rule was no rule); privileged steps are declared under `network.privileged` and **PRINTED, never run**. `cloudflared` is the only built-in whose `install.command` the server may run. **Platform support is manifest data** (`subshell.network.platforms`): availability is answered without loading plugin code.
- **`host.secrets` has no `get`, deliberately** (a readable credential could reach argv, a log line, or a browser hint). 0600 under `<dataDir>/plugins-state/`, hydrated only into a HOST-spawned child. **Full instance archives include it**; older database-only snapshots do not. The UI distinguishes this at the field. Mesh keys transit argv once, single-use; Subshell stores nothing of them.
- **Cloudflare Tunnel** is the one `public-with-gate` inversion of §0: exposure is manifest data rendered before the button; publish requires a pre-flight proving an Access application covers the hostname; the server verifies the assertion itself (keyed on the **`Host` header**, `jwtVerify` against the team JWKS, issuer and `aud` pinned, failing closed `403 ACCESS_DENIED` with no exemptions, plus refusing a matching `Host` from a non-loopback address). Disable/unpublish stop the process FIRST and drop the guard LAST. The assertion is a front door, never a session: Subshell's own cookie is still required.
- **No proxy header is trusted** (`X-Forwarded-*`, `Tailscale-User-Login`, `Cf-Access-Authenticated-User-Email` ignored). Login backoff stays per-email; a future per-IP limit must read `CF-Connecting-IP`, only behind the guard.
- **Trust follows the plugin's RECORD, live**: a publish never unions into `TRUSTED_ORIGINS` (that key is the operator's extras alone). `private` networks: trusted from membership; `public-with-gate`: only once `published`; `publishImplicit`: the join IS the publish (audited `by: join`). Disable/uninstall/leave FORGET the contribution (double-checked so an in-flight probe cannot resurrect it). `canonicalPluginOrigin` refuses unparseable/`"null"`/wildcard entries: **dropped with a warn, never thrown**. Audit rows name origins and field NAMES, never values.
- **A plugin-reported URL is `http:`/`https:` or not rendered**, checked three times over with different failures (manifest parser REFUSES a bad `docsUrl` at load; the gate DROPS a bad runtime URL keeping the sentence; the page renders no anchor, `lib/safe-href.ts`). Do not remove a layer on the grounds that React neutralizes `javascript:` hrefs. `secureContext` on each address is a statement about the browser (passkeys, `Secure` cookies), not about encryption.

## Authentication

The rules that decide who a credential is, moved here from the security
summary (which auto-loads into every session) because they live in this
package: `src/api/auth-guard.ts`, `src/auth/`, and the sign-in routes. "§N"
references below point into `docs/security.md`.

Four credential kinds; `apps/server/api/src/api/auth-guard.ts` is the only place credentials become principals.

- **Session cookie**: HttpOnly, `SameSite=Lax` always; `Secure` only when `APP_BASE_URL` is https (the marking follows the base URL, not `NODE_ENV`). The only actor admin surfaces accept, and the only one that mints an **unbound** WS attach token.
- **System key** (`Bearer subshell_…`, admin-minted under Server Settings → API keys; plaintext shown once, hash at rest; disable/delete revokes instantly): long-lived, with explicit versioned permissions on new keys; unannotated authenticated routes deny scoped keys. Scoped keys need `subshells:execute` to mint a WS attach token for a **system-owned** pane. Legacy keys retain their previous non-node access and may bind a WS token to any named pane. See `docs/security.md` §2 for inheritance and revocation limits.
- **Subshell token**: 7-day TTL, self-extending while its MCP child runs; revoked **instantly** on terminate/delete; rotated on restart on the same row. Permissions `{channels:[read,write], subshells:[read,write], prompts:[read,write]}`: a scope gate, not a row fence (§4); a map minted before prompts lacks the key and passes only that resource's check (§4). Mints a WS attach token only for its **own** pane.
- **Node key**: `/ws/node` and the encrypted, pinned-identity discovery envelope at `/api/nodes/route` only; **no plaintext bearer access on REST** (permanent guard rejection, §5.5); refused at the upgrade chain's final tier while its owner's account is disabled (HTTP-403-shaped close `4403` pre-socket, the check landing after `apiKeyId`; `local`/system-owned rows unaffected); blast radius = impersonating that one node.

**Forgery defense**: the guard never trusts api-key metadata: a key is a subshell principal only when the subshell row's `api_key_id` (written only by `issueSubshellToken`) equals the presenting key's id; `/api/auth/api-key/*` self-service endpoints are blocked inside the auth passthrough on every method (Elysia's broader GET route can outrank an ALL wildcard); a key whose `referenceId` is not the `system` service user is not a system key; a valid key whose subshell row is gone returns 401 (**the row is lifecycle truth**); raw SQL against `apikey` lives only in `src/auth/apikey-store.ts`, scoped with `json_extract`, never `LIKE`.

**Registration**: the first registered user becomes admin. The email gate is the **E-mail provider row's** `registration_enabled` (Settings → Auth is the sole surface; a legacy PATCH of the old `allow_registrations` key translates to the row, audited under the old name). NULL on the row = the legacy dynamic window, open **only while the instance has no users at all**; a stored value fails closed unless exactly 1. Every OIDC provider answers its own `registration_enabled` (explicit 0/1, NULL reads closed). One function decides the email answer (`services/registration-gate.ts`) for all three surfaces.

**OIDC providers** (spec 2026-09-24; §2): config lives in `auth_providers`; the E-mail row is a provider too (undeletable, kind-immutable). `/api/auth-providers` is cookie-admin only: the secret is never serialized (lists carry `hasSecret`) and never audited; verification runs only on save, never at build; endpoints and `accountIssuer` are stored so rebuilds run offline and a drifted issuer cannot crash boot. The id slug is `[a-z0-9-]` ≤40 with `email` reserved (`SLUG_TAKEN`); any write closing the LAST open sign-in provider is a `LAST_SIGN_IN_PROVIDER` 409, its guard one transaction with the write. Adding a provider is the same trust decision class as installing a plugin: with `requireLocalEmailVerified: false` the provider's **verified email claim IS the link defense** (§5's inversion; a verified match flips the local `emailVerified`). Provider policy is the global `user.validateUserInfo` hook plus the `hooks.before` guard on `/sign-in/email` and passkey verify (the hook never fires there). A `require_approval` provider's first arrival is created but refused its session; pending and rejected render the identical screen; a pending person never gets a session, never appears in `GET /api/users`; expiry sweeps delete stale `pending` rows (rejected never expire); approval only moves rows OUT of the queue. `kind` is a preset, the slug is unique: N providers per kind are legal, login buttons label by provider NAME. A callback host is never composed from the request: the `redirect_uri` emitted to the IdP is always a stored string (§5a). The provider guard refuses sign-in on EITHER close flag (`enabled` or `sign_in_enabled` = 0) while the registration gate never refuses an existing account (§5a). Response codes and hook specifics: §2. (The architecture-level account: the "Sign-in providers" note under Architecture and `apps/server/api/docs/auth-providers.md`.)

**Passkeys** mint the same session cookie: an additional credential, never a second factor. rpID = the configured `APP_BASE_URL` host (better-auth 1.7.1, static baseURL): they work only on that exact address. Not behind the login backoff (no email to attribute; the authenticator is the gate).

**Break-glass**: while `SUBSHELL_EMERGENCY_PASSWORD` is set, an admin signing in with that exact value has **their credential overwritten** (a destructive reset, not a bypass); constant-time, shares the login backoff, audited `emergency_login.rewrite_credential`, banner-flagged via `emergencyLoginActive`. Clear the variable after recovery.

**Account disable** (`PATCH /api/users/:id/disabled`, admin cookie, audited `user.disabled_change`): ONE transaction that also counts admins and revokes every session the target holds; last-admin 409, self-disable 400. Reaches new sessions (password and passkey) and the bearer path (a running subshell's token dies with its disabled owner); drops the target's live WebSockets (close 1012; re-enable drops nothing; while disabled no token can be minted); and disconnects every node the target owns (live and held sockets `4403`, the upgrade chain refuses the key until re-enable, agent redials within its 60 s backoff; `nodesDisconnected` rides the metadata; the confirm dialog says all of it: disable reaches the person AND their machines). The auth fetch wrapper strips cached session data when the DB-backed session token is invalid, so a copied cache cannot outlive revoked session rows; `authGuard` also reads the DB per request.

**Admin user management** (`/api/users`, writes cookie-admin): create, `PATCH :id/role` (last-admin demotion refused; counted and written in one transaction), `PATCH :id/password`, `PATCH :id/approval` (queue arrivals only). A reset revokes **every session** but NOT passkeys (own table, self-service delete) and NOT live WebSockets: credential rotation, not a session-kill switch (§11.5). Admins cannot reset their own password there; the `system` service account is untouchable; the password is never logged, echoed or audited, only the fact and the session count. User DELETION does not exist, by design.

**The one anonymous read** (§2): `GET /api/settings/instance` → `{ instanceName, providers, emailSignIn }`: ONE route, the sole pre-auth route outside first-run; it names the open sign-in providers (id, name, kind only; never issuer, client id, or any secret). Load-bearing guards: own route module (`authGuard` is scoped to the whole settings group, so nothing of `GET /api/settings/public` is anonymous); a test asserts the **entire response key set and the nested providers shape** (`GET /api/admin/server` carries the same rule); `instanceName` normalized on read as well as write (provider names are served as stored, trimmed only at write). Never fold it into `GET /api/setup/status` (infinite stale cache).

**WS attach** (§8): 30 s single-use token from `POST /api/auth/ws-token`; a cookie mints unbound; a **system key** binds it to any named pane; a **subshell's own key** only its own, by `sess:` equality checked **before** the row lookup (a bad id cannot enumerate subshells). Redemption CONSUMES the token, then checks the bind; a wrong-pane attempt burns it and gets the same `4001` a bad token gets. `/ws/live` refuses scoped tokens outright; BOTH redemption sites (`attach-resolve`, the feed's `handleLiveOpen`) re-ask `accountDisabled` after consuming: the flag cannot be beaten; the feed fails CLOSED on a throwing re-ask (a feed socket is never re-checked once open). With **no token parameter** the upgrade resolves the session cookie directly (same-host WebSockets run on this; the upgrade rejects a present Origin outside the live trusted-origin registry); that fallback applies the same `accountDisabled` refusal the REST guard makes. A WS authenticates at connect and is never re-checked (§11.5). Outstanding tokens are capped (`MAX_PENDING_WS_TOKENS` = 10 000: sweep-then-refuse).

**Login rate limit**: per email only, `2^n` s capped at 30, emails lowercased and trimmed. Nothing else is rate-limited.

**Mobile app** (§2): the session token lives in `expo-secure-store` and is sent as a `Cookie` header (the server sees an ordinary session); biometrics gate **use** of the token, not storage, and a device with no biometric enrollment degrades to allowed; `AsyncStorage` holds only the non-secret instance registry and the last push token.

## Pane logs & input

The pane logs and the pane's input doors (moved here from the security summary;
"§N" references point into `docs/security.md`). This is the canonical plane copy
of the whole rule-set; the launch/argv/hook halves on a node sit beside their
executor in `apps/node/agent/AGENTS.md` ("Pane launch posture"), and the
capture child's own account is in Architecture above.

- Panes stream via `tmux pipe-pane` into `<SUBSHELL_SERVER_DATA_DIR>/subshells/<id>.log` (on the node's disk for a remote subshell), plaintext by decision, holding **what was typed** (pasted tokens included) as well as output: the most sensitive artifact the app writes.
- The capture child is the **self-invoked `pane-log` verb**, never `cat` (uutils coreutils buffers small newline-less writes and froze the live view); `cat >>` stays only as pipePane's no-child fallback.
- Files 0600 (`O_CREAT` with mode 0600: a umask can only clear bits), dir 0700; `services/pane-log-hygiene.ts` repairs old files at boot.
- Local retention: hourly sweep of **non-running** logs after `SUBSHELL_LOG_RETENTION_DAYS` (default 30; `0` = keep forever); deleting a subshell unlinks its log at once; **running logs are never swept** (live replay buffer); sweeps re-probe liveness PER FILE immediately before each unlink, unknown-not-dead. **Node-side logs sweep on the node itself** (`apps/node/agent/src/pane-log-retention.ts`): boot + hourly, window from the agent's `config.json` or `SUBSHELL_LOG_RETENTION_DAYS`/`_HOURS` env (env wins per field), **default 1 day**, `0+0` = keep forever; a throwing probe counts as running; only `<valid-id>.log` names inside the data dir are eligible (same `pathAllowed`/`isSubshellId` rules as `remove_paths`, never follows symlinks). `remove_paths` at delete stays the prompt removal. (The node's own account of its half: `apps/node/agent/AGENTS.md`, "Pane-log retention".)
- Never add a code path that copies pane content elsewhere (log line, notification body, diagnostic dump) without deciding its lifetime. `SUBSHELL_ATTACH_DEBUG=1` is the one exception: off by default, world-readable dumps under `/tmp/subshell-attach-debug/`, never swept.
- Typed input transits argv (`tmux send-keys -t <id> -l -- <input>`, a paste is one argv element, `/proc`-readable); the pane's bearer token rides the launch argv **and the pane's tmux hook table**. Accepted (§11.2, §11.14).
- REST pane input `POST /api/subshells/:id/input` (the MCP `send_to_subshell` door) rides the **same `sendInput` seam and argv posture** as every send-keys path, gated at `edit`, bearer following the per-subshell switch-off; RUNNING is the row's **two** facts (`status` **and** `alive`), so a self-exited pane parked at `status:running, alive:0` answers a clean 409, not a 500; `submit` sends Enter as a second frame, so text+CR are ordered but **non-atomic**; writes no row: no announce, no audit (§4).
- REST pane exec `POST /api/subshells/:id/exec` (the MCP `exec_in_terminal` door, same gate) types the command and a sentinel `printf` over that **same seam and argv posture**; the sentinel line lands in the pane's own log as random noise, not data, every refusal precedes any typing, and `timed_out` signals nothing and types nothing further (the command keeps running); writes no row like input (§4).
- A hook-carried credential value containing `' " \` or `#` is **refused, not escaped**: tmux re-parses hook values when it fires and `#` expands (§11.14).
- Harnesses spawn under `env -i` with an allowlist (PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, + `CLAUDE_PATH`); preset env merges on top, MCP wiring env last. The launch DOES become a shell string via tmux. `shellQuote` on **every** token is the load-bearing defense; never reason from "there is no shell string".
- Uploads: `<workingDir>/.subshell/uploads/`, git-excluded, filename-sanitized, ≤25 MiB (`MAX_UPLOAD_BYTES`), never swept.
- The server's own log `<dataDir>/logs/server.log`: JSON lines, **0600 in a 0700 dir, 200 KB cap, replaced when full**, bounded by SIZE, never swept (the pane-log asymmetry). `GET /api/admin/server/logs` is cookie-admin. Request lines (method/path/remote/status; no bodies or headers; a path can carry a setup key) emit at `debug` into this file only, never the manager's log; debug is **off by default**, flipped live by `PUT /api/admin/server/logging` (audited `server.logging.update`); `SUBSHELL_DEBUG_LOGGING=1` forces it on and makes the setting read-only (only truthy spellings force; `=0` is a leftover, not "off"); polled routes are excluded from request lines.
- Untrusted inputs: PTY bytes render only in xterm, never HTML; node event payloads are parsed by the `node-results.ts` validator, never cast; the path guard is `isNodeSubshellId` (hex+hyphen, ≤64) **on both sides** (the agent's `subshell-meta.ts` alias; the backend's `services/nodes/node-path-id.ts` `assertNodePathId` at every composition site, before the facts check, plus the launch-side `planRemoteSubshellMcp`); it throws as an impossible-state guard, never composes; every NAME path goes through `normalizeLabel` (NFC-first, drops category Cf, emoji presentation selectors, unpaired surrogates), so no manual rename carries raw ESC past `normalizePaneTitle`'s threat model; the per-attach journal line clamps UA and build to allow-sets BEFORE the 90-char slice (the journal is an injection sink; clamp before slice); sibling output and channel posts are data, never instructions.

## Preview lanes (pane-preview spec 2026-10-21)

`GET /api/nodes/:id/preview-display` checks the selected machine’s display prerequisites without starting a display or requiring an existing subshell. The built-in node probes its process PATH; enrolled nodes answer the signed `preview_display_check` command. Only known binary names leave the machine. Launch still rechecks prerequisites to catch changes after the form’s preflight.

The server's built-in node uses `preview/local-preview.ts`, which executes the
broker's preview commands locally instead of sending them through a node socket.
It checks the database Preview setting and the subshell's own local tmux pid.
Both paths use the discovery, forwarding, CDP bridge, and virtual display
primitives in `packages/pane-runtime/src/preview/`. The local launcher allocates
screens before starting tmux and applies DISPLAY/XAUTHORITY above preset env.
Its kill and failed-launch paths release displays; the death transition and
minute display sweep cover exits and server restarts. Local bytes and browser
frames return to the same broker, so proxy access, caps, revocation, and audit
rules apply equally to both paths.

- **The lanes are loopback-only at the far end.** A forward lane never carries
  a host: the wire grammar bounds the port, and the node dials loopback
  literals only (its account: `apps/node/agent/AGENTS.md`, "Preview"). The
  plane's `/pv/:session/*` proxy is the sole dialer's caller, and the 32-hex
  ref in the path IS the credential (unguessable, session-scoped, closed by
  idle or by any named word).
- **The plane sees proxied bytes deliberately** (spec §8): a lane exists so the
  browser can talk to a port bound only on the node, and every byte crosses
  the encrypted node link through this process. That is the feature's whole
  shape, not a gap: what a lane reaches is what a viewer with `edit` access
  could type into the pane's own browser anyway. `Host` is rewritten to
  `127.0.0.1:<port>` so dev-server host checks see loopback.
- **Watch frames ride `/ws/live`, so the §11.14 control covers their audience.**
  The frames themselves do NOT ride the topic machinery:
  `configurePreviewStreamSender` (`live-ws.ts`) installs a direct-socket
  sender (`sendPreviewStreamSocket`, `live-registry.ts`) and the broker fans
  bytes straight to the sockets in its own registry. The control holds anyway
  because only `watch` registration puts a socket into that set (gated through
  the same visibility resolver as every other read), and every grant change
  cuts it back out (`closeUnauthorizedForPane` on a shares write, the
  role-change and disable user sweeps); the exhaustive diff test covers this
  fan-out's viewer→row pairing too. watch/unwatch sit at `view`, open/Screen
  at `edit` (spec §7), and the broker drops frames with no subscriber rather
  than buffering them.
- The per-node switch is the gate in front of all of it (`node.preview-enabled`,
  audited `node.preview_enabled.update`); every preview route answers the node
  state itself with its named refusal rather than inventing one: the plane's own
  state words (`preview-disabled`, `node-held`, `node-too-old`, `node-offline`,
  `node-timeout`), the node's refusal words passed through verbatim
  (`preview-ports-unsupported`, `preview-ports-pane-gone`, the `preview-display-*`
  family, `preview-pane-gone`), and the bridge's `watch-port-conflict` 409. The
  watch route's missing-port case is a 400 sentence, not a code.

## SSH

The route inventory and trust limits are in `docs/security.md` ("SSH surfaces
and credential boundaries"); the confirmation routes' own mechanics live in this
file's "First-connection SSH destination confirmation" section below. The rules
(moved here from the security summary):

`/api/ssh/*` requires a browser session; SSH terminal input additionally requires the pane owner and refuses all bearer actors. The node SSH switch is owner-only (admin for the built-in node), including implicit enablement on launch. It controls outgoing SSH and agent-key supply, not incoming access. Port forwards are declared per connection, never config-derived (that refusal stands): loopback binds by default, and a non-loopback bind needs the node's owner-only wide-forwards switch (`node.ssh_wide_forwards.update`); remote-forward binds answer to the destination's sshd policy. The subshell view carries a bounded summary (canonical destination, declared rows) for the pane header: disclosure-only, same class as the audit's. Relays require access to both nodes; the UI requires key selection, while the cookie API can select the current roster when selection is omitted. Private keys stay at the source. Bounded configuration scanning does not prevent all local execution during `ssh -G`; trust the connecting account’s SSH configuration. First-use destination confirmation cannot replace a conflicting pin. Host-pin recovery APIs remain even though their settings UI is gone. Passwords enter through the terminal, are not saved as credentials, and are still visible to trusted transport endpoints. Recent suggestions and SSH presets are not trust pins.

**Local key signing** (`/api/ssh/local-key*`, cookie-session only) feeds signatures through a session-scoped, sequence-checked, one-use bridge: one key, ≤8 requests, 90 s. The browser worker's disposal is a lifetime boundary, NOT a defense against the page it runs in (that path's trust-the-site checkbox is load-bearing); the native path keeps private material outside the remote page and approves the destination natively.

## CORS & rate limiting

Cookie authentication in `authGuard` and the separate setup/network credential
gate, plus browser upgrades at `/ws` and `/ws/live`, reject a present Origin
outside the live trusted-origin registry.
CORS alone does not reject form writes, and SameSite cookies still accompany
same-site requests from other origins. Native clients may omit Origin; empty
and opaque origins are refused. Explicit bearer REST requests keep their
credential and scope checks.

The origin allowlist and the one rate limit, moved here from the security
summary ("§8" points into `docs/security.md`). The config.env section under
"Standalone binary & CLI" already states the one-writer rule (`applyConfig`),
the `URL.origin` canonicalization, the wildcard refusal, the
written-or-removed-never-empty key, and the per-entry `status` diagnostics;
those lines stand in for the repeated fragments, and everything else the two
bullets carry is here:

- The origin allowlist (§8) is **derived live, per request**, from four sources, none the request: the instance's own origins (both loopback spellings of `SERVER_PORT`, a concrete `HOST`, the `APP_BASE_URL` origin); this machine's non-internal IPv4 interfaces **on a wildcard bind** (`services/lan-origins.ts`; re-probed on `GET /api/settings/public`); the operator's `TRUSTED_ORIGINS`; and each enabled network plugin's recorded addresses for this host. NEVER "trust the origin that matches the request Host": that is the DNS-rebinding hole. A literal-IP entry cannot be matched by a rebinding attack (whose `Origin` carries the attacker's hostname, never the IP). The LAN probe closes the same-Wi-Fi-IP case only: a LAN *hostname* still needs an explicit entry.
- **Entries are validated by component** (http(s) scheme, a host required, no path/query/fragment; credentials refused, not silently stripped); the canonical `URL.origin` storage and the refusal of wildcards are stated in the config.env section above. **The refusal is load-bearing:** better-auth routes wildcard-carrying entries through `wildcardMatch` (`https://*` measured to trust every https origin), and CORS is no backstop either way (a non-browser client sends any `Origin`). An env var or a hand-edit still bypasses the validator.
- All writers (CLI `configure --trusted-origins`, the dashboard's Addresses card, the restart route) go through one `applyConfig`, the one writer named in the config.env section above. A value already on disk passes through byte-identical with a warning: only a CHANGED value must validate. `subshell-server status` reports per-entry problems **with the supplying layer** (a diagnostic, not a boot gate; the full account: `apps/server/api/docs/config-env.md`).
- `APP_BASE_URL` is also better-auth's passkey rpID: changing it moves where passkeys work, the `Secure` cookie marking, and (https) where the Server app window opens. Adding a name to `TRUSTED_ORIGINS` is passkey-neutral, the "also reachable at" lever.
- `HOST` defaults to `0.0.0.0`: a first-run instance is LAN-reachable with registration open before anyone touches it; bind loopback or set the env before first boot on a network you do not own.
- Login is the only rate-limited surface. Production refuses to boot on the placeholder `BETTER_AUTH_SECRET` and enforces the origin check strictly.

## Audit event names (§10)

The full inventory, moved here from the security summary ("§N" points into
`docs/security.md`).

Read via `GET /api/audit?limit=50` (admin). Rules: auth-family metadata carries method and ids, NEVER tokens/emails/IPs/UAs; the user-management family names its subject by email by convention (§3). Sign-in rows are SUCCESS only (failures write nothing so the trail can't be spam-DoSed); `auth.sign_out` is one row per session ended; trusted-origin probes write no row.

Auth `auth.sign_in` / `auth.sign_out` · users/keys `user.create|role_change|password_reset|disabled_change|approve|reject`, `system-key.create|enable|disable|delete`, `emergency_login.rewrite_credential`, `setup_key.create` (no metadata) / `setup_key.revoke`, `settings.update` · auth providers `auth_provider.create|update|delete` (fields + issuer, never the secret) · subshells `subshell.create|terminate|restart|preset_switch|delete` · transfers `transfer.create|complete` (node ids, paths, byte and entry counts, sync flag, outcome; never contents) · nodes `node.enroll|delete|rename|key_rotate|reregister_key|reregister|allowed_dirs.update|config.update|maintenance.update|ssh_enabled.update|ssh_wide_forwards.update|ssh_identity.register (signing-key bootstrap over the link, ids + via only, never the key)|ssh_machine_pin.repair (verified peer replacement; ids only)|ssh_identity.repair (admin-verified server disk identity; metadata null)|ssh_host_pin.create|ssh_host_pin.delete (canonical destination and public host fingerprint only)|ssh_relay.open|ssh_relay.close (plane rows, actorUserId null, named reason word, fingerprint COUNT only)|ssh_upgrade.run (the "Set up Subshell here" act, Task 14: pane/B/A ids and relay ref, canonical destination, exec id, outcome + service-chosen stage word; the minted setup key and ALL installer output appear in NO row and NO refusal copy)|preview_forward.open|close, preview_watch.open|close, preview_display.open|close (lane, bridge, and display lifecycle, each close with the named reason word), preview_enabled.update (the per-node switch), preview_lane.over_cap (the plane's sender-cap lane death, the only lane-level action; the session survives it), preview_watch.viewer_drop (viewer-level drops that close nothing: the attach-cap refusal and the byte-debt detach, with the close-reason word in metadata and never a ref)|logging.update|update|update.unknown|shares_set|local_share_changed|service`, and the SSH launcher's `ssh.launch` `{nodeId, destination, subshellId, relayRef on a relay launch, bounded forwards summary}` (success only, written after the pane spawned; the canonical `host:port` and the declared rows' ports and hosts, never config or key material; SSH preset CRUD unaudited, the prompts precedent) · server `server.config.update|restart|logging.update|autostart.update|update|supervision.request` · plugins/networks/installers `plugin.install|enable|disable|uninstall|unpublish`, `network.configure|install|join|publish|unpublish|leave`, `agent.install`, `tmux.install`. Per-event metadata detail: §10.

## Updates & releases

Design: `docs/superpowers/specs/2026-09-15-updates-design.md` (§15 "Amendments made while building" is what shipped, not §§1–14). Publishing mechanics: `docs/release-and-ci.md`. The rules to code by (moved here from the security summary; "§N" points into `docs/security.md`; the transaction's implementation account is this file's "Updating the server" section and `apps/server/api/docs/updating.md`):

- One release list, one pure selector (`packages/subshell-protocol/src/releases.ts`): newest-by-**semver**, never by date (four components share one repo). `SUBSHELL_RELEASE_URL` is the only seam; **empty = air-gapped, every network path refuses by name**, naming `--from` or a hand install.
- **Signed-manifest rule** (§11.12): every release's `release-manifest.json` is verified against its detached minisign `.sig` (the publisher keypair) before ANY of it is trusted, at every update path and on the node itself. **Install digests come from the signed `assets` map, never from a `.sha256` sidecar.** No manifest / no sig / bad sig ⇒ refused BY NAME, never offered. The two stated exceptions: install one-liners keep the sidecar rule (their machines hold no key yet; the first UPDATE is verified), and local unsigned publishes are legal for your own instance (served by digest through the authenticated route) while a plane never OFFERS them. A compromised release source can withhold or replay signed releases, not mint new ones; TLS is delivery only.
- **One publisher keypair for all four components**; losing `TAURI_SIGNING_PRIVATE_KEY` means no installed component can ever auto-update again. Its three committed spellings (both `tauri.conf.json` pubkeys + `RELEASE_PUBKEY`) are pinned equal by `release-pubkey.test.ts`; a cut refuses the placeholder, every shard fails loudly when the private key is unset.
- **Server update** (`POST /api/admin/server/update`, cookie-admin, bearer refused, audited at the start AND at the completing boot with actor `null`): the URL comes from the release index, NEVER the request body; `version` only SELECTS among published tags; the downloaded binary must answer `<temp> version` with the version being installed; refused (notably `RESTART_UNAVAILABLE`) rather than updating into nothing; the job slot is a one-synchronous-check-and-set CLAIM taken immediately before start: the claim IS the lock.
- **Node update** (`POST /api/nodes/:id/update`, `nodeCanConfigure` gate, cookie only, `local` refused, audited): URL, digest and the VERIFIED manifest+signature travel INSIDE the signed command; the node re-verifies against its own compiled-in pubkey; old-protocol agents are refused by the plane, and the AGENT refuses a non-newer `version` unless the command carries `force` (equal version refused even under force; the loopback dashboard's deliberate downgrade path keeps working; the agent's own posture: `apps/node/agent/AGENTS.md`). The `nut_…` download token is not a general credential: in-memory, 10-minute, single-use, checked against the platform triple and named digest; a server restart forgets outstanding tokens.
- **Every install is a transaction the NEW binary completes at boot**: the swapper FIRST keeps the old binary as `.previous` (`keepPreviousBinary`) then performs **ONE rename onto the live path** (never rename-aside-then-in, whose crash window left NO bootable binary with an unrevertable marker), and it writes the marker. The boot finalizes (migrations pass → audit, delete both) or reverts (restore DB backup, rename `.previous` back, record the failure, exit 1 so the manager respawns the old version). The node mirrors it without the database half. **Never write the installed binary by convention**: it is the file the SERVICE DEFINITION names, else the one this process IS, else nothing (`services/installed-binary.ts`; `selfInvokePrefix()` on the node).
- **Full instance archive before every upgrade**: 0600 in a 0700 dir at `<dataDir>/backups/` (explicit chmod after `VACUUM INTO`); bounded by `SUBSHELL_DB_BACKUPS_KEEP`. Rollback restores **database → binary → marker** (Kysely is forward-only: an old binary cannot boot a newer DB); `restoreDatabase` `wal_checkpoint(TRUNCATE)`s BEFORE unlinking WAL sidecars (a stale self-consistent WAL would REPLAY onto the restored snapshot); a `pending.json` naming a version that is not booting is RECORDED as a failure. Desktop "install the bundled server" on a managed install delegates to `<installed> update --from <sidecar> --yes --no-restart --json`; the FIRST install still copies the sidecar.
- **Desktop updaters**: `tauri-plugin-updater` verifies minisign over the BUNDLE bytes against the compiled-in pubkey; CLI paths verify over the MANIFEST bytes then match files against the signed digest. One desktop update act spans a relaunch (spec 2026-09-18): pane-safety consent persists as `settings.json` `pendingBundledInstall.forced` (never written by a page; `desktop_install_app_update` takes booleans only and ANDs `forced` with the machine's own `pane_risk_now`: a page can decline, never manufacture, a force); the marker never decides work EXISTS (re-derived at boot); retries bounded at two; the updater commands are BUNDLED-window grants only; no remote window gained one. (The per-app halves: `apps/server/desktop/AGENTS.md` and `apps/client/desktop/AGENTS.md`.)

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
| `PATCH /api/admin/server/config` | rewrite config.env through the CLI's own writer (see `apps/server/api/docs/config-env.md`). `DATABASE_PATH` is deliberately absent, and so is the auth secret. A key the process env already carries is refused 409 and never written: a write the next boot masks is a fake success |
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
  excluded. The one exception is `--verbose` / `SUBSHELL_VERBOSE=1`
  (2026-09-26): both raise THE CONSOLE transport to debug for the life of
  a hand-invoked run (`setConsoleVerbose` in `utils/logger.ts`, the
  deliberate mirror of `applyDebugLogging` that never touches the FILE
  gate, the settings row, or the env-forced read-only rule), and either
  is refused together with `--json` where a command emits JSON. HTTP
  request lines surface with it NOT because of group plumbing (the
  elysia logger group-routes only when its caller passes a `group`, and
  `context.plugin.ts` does not) but because what kept them out of the
  journal was always the console's own `info` gate.
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

## Instance backup and restore

Full manual archives and offline transactional restoration live in
`services/backups/`; Settings only downloads, inspects, and stages. Read
`apps/server/api/docs/backups.md` before changing capture locks, pre-config
recovery, restore receipts, encryption, or temporary admin recovery. User
procedures live in `apps/docs/content/docs/administration/backups.mdx`.

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
`backup`; `restore` (offline instance replacement); `mcp` (the one long-running verb, spawned by harnesses);
`report attention …` / `report session` (generated harness-hook lines,
never typed; ALWAYS exits 0).

An unknown word exits 1 with usage. **Sync-exit design** (house style for
the quick commands, no longer the safety mechanism): a handled command
should run to completion and `process.exit` SYNCHRONOUSLY inside
`dispatchCli` (sync fs, `Bun.spawnSync` for the service manager). There are
now SIX exceptions rather than one: `mcp`, long-running by design and
suspended in its stdio loop; `init` and `configure`, which became async
when their prompts moved to `@clack/prompts` (spec 2026-09-15), since a promise-based
library cannot be driven by `readSync(0, …)`; `update` and `backup` (spec
2026-09-15 §4.1/§4.4), which download, prompt and `VACUUM INTO` a database;
and `restore`, which stages and validates an archive, performs offline
replacement, and awaits boot confirmation. `update` and `restore` can wait
for the restarted server to finish or revert their transaction; restore's
readiness probes also perform network I/O.

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
The macOS ladder is three-way (2026-09-26): `brew`, then MacPorts (`port`,
which self-escalates through portsudoers), and with neither an offer to
install Homebrew itself through Homebrew's own documented installer (their
infra, not ours). BOTH non-brew rungs carry `needsTerminal` (the bootstrap's
child prompts for an admin password; `port` escalates where a password
prompt may appear), and every terminal-less gate reads that FLAG, so a run
without any terminal gets loud instructions instead of an attempt on either
one. `init` also acquired its own terminal first: a piped run
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
fixtures straight in. A bare `bun test` runs files serially in one process,
so they all share that DB; the `test` script adds `--parallel=12` (issue
#261), where every file gets a fresh module registry and so its own DB
file. Suites must therefore migrate their own DB (`@/__tests__/helpers/
test-database.js`) and may assume neither an empty one nor a sibling file's
boot. Tests never touch `data/`.

**A run reaps its own tmux servers**: `test` runs `scripts/test-run.sh`,
which owns the run's `TMUX_TMPDIR=$(mktemp -d /tmp/subshell-test-tmux-XXXXXX)`
namespace and, after `bun test` exits, `kill-server`s every socket it lists
and removes the directory. It lives in the script, not the preload, because
issue #261 measured that a preload `afterAll` fires after EVERY file under
`--parallel` - a directory-scoped sweep there would kill sibling workers'
live panes. A bare hand-typed `bun test` gets no net, which is correct,
since it also gets the shared default socket dir, where killing anything
would reach panes the run never started. The net covers THIS package only;
`packages/pane-runtime` and `apps/node/agent` stand on each suite's own
register-before-spawn `afterAll`. The `--timeout 30000` in the script is
measured: this package's DB + better-auth setup against the temp DB is
what blows bun's 5 s default under CI load, not the tests. Why each is
shaped this way (the leaked-harness incident, the parallel per-file firing
that moved the sweep out of the preload, the CI run numbers):
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

## List filters

The dashboard sends optional `q` parameters to the nodes, subshells, prompts,
prompt stacks, and workspaces list routes. Matching is a trimmed,
case-insensitive literal substring, after the caller's visibility rules.
Nodes also accept `status` and `access`; subshells accept `nodeId`; stacks
accept `empty=only` for owned stacks. Prompts and stacks also accept
`scope=own|shared`. Search stack members only after dropping
references the caller cannot see. (Workspaces used to take `locale` and
`timeZone` for draft-label matching; the draft model and those params are gone
with spec 2026-10-17.)

Search lengths come from `LIST_SEARCH_MAX` in the protocol package; use the
same constants for browser input limits. Keep identifier filters bounded,
validate locale and time zone at any route that takes them (the workspaces
list stopped taking them with spec 2026-10-17), and retain enum validation
for select filters. See `docs/security.md`'s
Dashboard list search inputs section for the security constraints.

### First-connection SSH destination confirmation

The cookie-only `/api/ssh/verify-destination` routes handle unfamiliar relay
destinations. Discovery asks the connecting node for the public host identity,
without authentication or a trust write. A five-minute, one-use token binds the
viewer, selected nodes, resolved destination and exact identity. Acceptance
rechecks current access and alias resolution, then uses the existing pin store's
no-overwrite rule. Existing or conflicting trust cannot enter this path; the
host-pins API remains available for explicit operator recovery. See the SSH trust
accounting in `docs/security.md` §6.

Preview browser boundaries are documented in [Preview architecture](../../../docs/preview-architecture.md)
and [security §11.15](../../../docs/security.md#1115-preview-apps-browsers-and-virtual-displays).
Proxied documents require a response CSP sandbox without `allow-same-origin`,
plus the workspace iframe sandbox. Keep upstream cookies in the broker jar;
never write them to the dashboard browser. Only capability-bound preview CORS
and WS may accept opaque `Origin: null`; dashboard APIs and WS must keep refusing
it. View-only watch requests must match the shared subshell's discovered CDP port.

Strip dashboard HTTP/edge credentials and origin-wide target response policy
headers in the proxy. Explicit stop, delete, and restart must await broker
teardown before killing the old pane and sweep again after retiring its row.
Pending opens must participate in revocation and recheck current access before
publication; exit hooks and registered sessions alone cannot cover late RPCs.
Live-screen subscriptions must repeat access reads overtaken by a broker
revocation revision. Uncertain open replies need best-effort node cleanup too.
Keep target-controlled HTTP/WS queues and messages within the lane byte budget,
and retain the cookie-jar limits documented in the architecture guide.
