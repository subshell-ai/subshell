# Design: Management lives in the dashboard; the desktop apps keep only what a served page cannot do

Date: 2026-09-12
Status: proposed design, written from the operator's direction of 2026-09-12:
"once the server is set up, launching the app should go to the dashboard, not
the management page"; "move what we can into the SPA"; "a user can reach the
dashboard outside the app, and a server may be installed headless with no app
at all, so add APIs where the headless case needs them"; "apply the same
ideals to the client".
Supersedes: `2026-09-11-server-console-sidebar-design.md` (the console is
removed), § 3 "three windows" of `2026-09-10-desktop-first-run-wizard-and-reset-design.md`
(two windows now), and the client node page as inventoried in
`apps/client/desktop/AGENTS.md`. Leaves in force: the assistant frame
(`2026-09-11-first-run-second-pass-design.md` § 3), the reset chains of
`2026-09-11-native-reset-both-desktop-apps-design.md` (its client half is
approved and unbuilt; § 6.5 says where it now lands), and the `onboarded`
flag.

Companion plan: `docs/superpowers/plans/2026-09-12-management-in-the-dashboard.md`.

## 1. The problem

Subshell Server is two programs the person can see at once. Once a machine is
set up, every launch opens the **console**: a 900×640 native window with a
sidebar (Overview, Logs, Settings → Addresses / Application, About). The
dashboard, the thing they installed the app to use, is one button away on
that page and one tray item away thereafter. The two windows have different
chrome, different type, different idioms, and neither explains the other.

The console exists for one true reason: it renders with the server **down**,
and it is the only surface allowed to drive the CLI. But most of what it shows
needs the server **up**: the version, the address, the config.env values, the
service state, the log tail. Everything in that set is something the server
knows about itself better than a process reading `status --json` does, and
none of it is reachable by a person who reaches the dashboard from a browser
on another machine, or who installed `subshell-server` on a headless box and
has no app at all. Today those people change addresses with a CLI flag and
read logs with `journalctl`.

Subshell Client has the same shape in miniature. Its bundled node window is a
single page of seven cards: the plane address, the node's own address, a
status card of twelve facts, the step card, the tray preference, the CLI's
raw output, and About. Four of those facts (node id, plane address, agent
version, online) are already on the control plane's Nodes page. The rest —
supervised by what, since when, where the config and log live, whether tmux
was found — are facts the agent could report and the plane could show to
every node's owner, including the owner of a headless node nobody ever opens
a window on.

## 2. The rule

**A management surface lives in the SPA and is backed by a server API. A
desktop app keeps a native page only for what a page the server serves cannot
do:**

1. acts that need the server (or the node daemon) to be **down or absent**:
   install the binary, write the first config, install and start the service,
   start a stopped one, repair, reset;
2. acts that need a **local process the plane has no reach to**: enroll this
   machine, pick a binary on disk, install the bundled sidecar;
3. **the app's own preferences**: keep running in the tray.

Everything else is a server fact or a server act, and the SPA shows it and
does it — for the desktop window, a browser on the LAN, and a headless
install alike. A desktop-only affordance in the SPA (a deep link into a
native screen) is allowed when it points at category 1 or 2, and it may name a
SCREEN, never a command.

Corollary for the "SPA can do it" side: **the SPA may perform any act that
leaves the server reachable afterwards.** Restart qualifies (the service
manager brings it back). Stop, uninstall and reset do not, and stay native or
CLI.

### 2.1 What the rule yields

Every console surface, and where it goes:

| Console surface today | After | Category |
|---|---|---|
| Overview hero: state word, version, address, "Open in browser" | SPA Settings → **Service**: the Service card (§ 4.1) | server fact |
| Overview step card, `ready`: Open Dashboard / Restart / Stop | Boot opens the dashboard (§ 5.2); **Restart** is `POST /api/admin/server/restart` from the Service card; Stop is CLI-only | server act / cat. 1 |
| Overview step card, `no-server` / `unreachable` / `init` / `install-service` / `start` | The assistant's **recovery screen** (§ 5.3) | cat. 1 |
| "Update server to X" | The assistant's **Update Server screen**, deep-linked from the SPA when the shell advertises a newer bundled server (§ 5.4) | cat. 2 |
| Overview Details: binary, config.env, tmux, MCP, port, service definition, manager, teardown, logs | Service card + **Locations** card (§ 4.3); the pre-boot subset also under the recovery screen's Show Details | server fact |
| Logs → Server log tab | **Server log** card over `GET /api/admin/server/logs` (§ 3.4); the recovery screen reads the same file for the down case | server fact |
| Logs → Command output tab | Recovery screen Show Details (native actions only) | cat. 1 |
| Settings → Addresses (port, host, base URL, trusted origins; Save and restart) | **Addresses** card over `PATCH /api/admin/server/config` + restart (§ 3.2, § 4.2) | server act |
| Settings → Application: tray preference | A check item in the tray menu itself (§ 5.5) | cat. 3 |
| Settings → Application: Reset this machine… | Unchanged entry from the SPA's General danger card; the screen is now in the assistant (§ 5.3) | cat. 1 |
| About | SPA **About** dialog for everyone (§ 4.5), the macOS About box, and one footer line in the assistant | — |

And the client node page:

| Node page today | After | Category |
|---|---|---|
| PlaneCard (plane URL, Open / In browser / Change) | The assistant's **Connect to a Server** screen, shown while no plane URL is stored; afterwards a "Change server…" link on the Connected screen | cat. 2 |
| NodePlaneCard (this node reports to X; repoint) | Connected screen disclosure | cat. 2 |
| StatusCard: agent version, found via, bundled, node id, daemon age, config file, service, manager, teardown, logs, tmux | Reported by the agent in `ready` and shown on the SPA node detail's **Runtime** card (§ 6.2) for any online node; the local subset stays under Show Details on the recovery screens | node fact |
| StepCard: install agent / enroll / install service / start / restart / stop / uninstall / update | Install, enroll, install-service, start: assistant recovery screens. **Restart**: `POST /api/nodes/:id/restart` from the SPA (§ 6.3). Stop, uninstall: CLI. Update: assistant screen (§ 6.6 explains why self-update is not in this spec) | cat. 1 / 2 / node act |
| PrefsCard (tray) | Tray check item | cat. 3 |
| OutputBlock | Show Details on the screen that ran the action | cat. 1 |
| AboutFooter | Kept as the assistant's footer line; the SPA About dialog cannot name the client app because that window carries no marker by design | — |

## 3. Server: four admin routes

All four live in the `adminRoutes` group (`api/routes.ts`), behind
`requireAdmin` — cookie session, admin role, bearer keys refused with 403,
exactly like `GET /api/admin/status`. New module directory
`api/admin-server/` with one file per route and an `index.ts` that composes
them, following `api/channels/`.

### 3.1 `GET /api/admin/server` — how this server is deployed

The server's view of its own deployment. Built from the existing
`collectStatus()` (`commands/status.ts`, the `status --json` contract) plus
`queryService()` (`service.ts`), plus the running process. Nothing here
duplicates `GET /api/admin/status` (versions, runtime metrics, inventory,
security): that route is *what is happening*; this one is *how it is set up*.

```ts
{
  configEnv: { path: string; exists: boolean };
  settings: {
    // one entry per key, in this order
    SERVER_PORT | HOST | APP_BASE_URL | DATABASE_PATH | TRUSTED_ORIGINS: {
      saved: string;            // what config.env (or the default) says
      source: "process env" | "config.env" | "default";
      running: string;          // what THIS process booted with
      problems?: { entry: string; reason: string }[];
    }
  };
  restartRequired: boolean;      // any key where saved !== running
  authSecret: { state: "set" | "missing"; source: SettingSource };
  paths: { dataDir: string; database: string; logsDir: string; nodeArtifacts: string; serverLog: string };
  service: {
    manager: "launchd" | "systemd" | null;
    installed: boolean;
    definitionPath: string | null;
    state: string;               // the manager's word, verbatim, as service.ts reports it
    pid: number | null;
    enabled: boolean | null;     // starts at login
    paneSafety: "keeps" | "kills" | "unknown";
    logPath: string | null;      // macOS file; null under systemd
    logHint: string | null;      // "journalctl --user -u subshell-server.service -f" when logPath is null
    supervised: boolean;         // § 3.3
  };
  restart: { available: boolean; reason: string | null };   // § 3.3
  logging: {                     // § 3.4
    debug: boolean;              // effective: debug level + HTTP request lines
    source: "process env" | "setting" | "default";
    file: string;                // paths.serverLog
    capBytes: 204800;
  };
  tmuxPath: string | null;
  mcp: { command: string; args: string[]; source: string } | null;
  mcpError: string | null;
  platform: "darwin" | "linux" | string;
  generatedAt: string;
}
```

`running` is what makes hand edits visible: someone who changed config.env
with an editor over ssh sees "Saved 3090 · Running 3080 · restart to apply"
without the SPA having written anything. `source: "process env"` marks a key
the file cannot change (§ 3.2). `queryService` spawns `systemctl`/`launchctl`;
the SPA polls this route every 15 s only while the Service page is mounted,
the same cadence `admin/status` already runs at.

### 3.2 `PATCH /api/admin/server/config` — rewrite config.env

Body, all optional, at least one present:

```ts
{ port?: number; host?: string; baseUrl?: string; trustedOrigins?: string[] }
```

`DATABASE_PATH` is deliberately not settable here. Moving the database from a
web page is a footgun with no undo, and the CLI's `--db-path` remains.

Validation and the write are **the CLI's, shared, not mirrored**:
`commands/configure.ts` is refactored so its core — merge with the stored
values, `validateValue` per key, canonicalize origins, compute the two
warnings (LAN bind with a loopback base URL; base-URL port ≠ bind port),
write the file atomically preserving every other key — is one exported
function (`applyConfig(input, deps)`) with no prompt, no `process.exit` and no
console output. `runConfigure` and the route both call it. A test asserts the
route and `configure --port …` produce byte-identical files from the same
input, which is the thing that keeps "validated by component and stored
canonicalized" (security-context "Which addresses a browser may use") true of
the new writer.

Refusals, before any write:

- **400 `CONFIG_INVALID`** `{ field, reason }` — `validateValue`'s reason,
  the same sentence the CLI prints.
- **409 `CONFIG_KEY_FROM_ENV`** `{ key, envVar }` — the key's source is
  `process env`, so a file write would be masked at the next boot and the
  route would report success for a change that never takes effect. The
  message names the variable to change instead. The SPA renders such a field
  read-only with that sentence (§ 4.2).

Response: the § 3.1 view after the write, plus `warnings: string[]`. Audit
`server.config.update` with `metadata.changes: [{ key, from, to }]` — these
are addresses, not secrets; `BETTER_AUTH_SECRET` is never touched by this
route and the audit test scans the metadata for it anyway.

### 3.3 `POST /api/admin/server/restart` — the server restarts itself

The server cannot see its own service manager from its environment: the unit
and plist templates set only `PATH` (inventoried 2026-09-12). It can see the
manager's answer, though, and that is a stronger fact than a marker:

```
supervised = service.state === "running" && service.pid === process.pid
```

`MainPID` (systemd) and `launchctl print`'s `pid` name the process the manager
started. When that is this process, exiting is a restart: the unit is
`Restart=always` / `RestartSec=5` and the plist is `KeepAlive=true`, both of
which respawn on any exit status. When it is not — `bun run start`, a
terminal, a container with no init — `restart.available` is `false` with
`reason` "This server is not running under a service manager; restart it
where you started it." and the route answers **409 `RESTART_UNAVAILABLE`**.

Pane safety follows the CLI: a definition whose `paneSafety` is not `keeps`
(no `KillMode=process`, no `AbandonProcessGroup`) would take the tmux panes
down with the process. The route refuses **409 `RESTART_KILLS_PANES`** unless
the body carries `{ force: true }`; the SPA's confirm dialog says so and
offers the forced path with the count of running subshells.

The act, on 202 `{ restarting: true, resumeAt: string }` (`resumeAt` is the
saved `APP_BASE_URL`, so a caller whose address is about to change knows where
to look):

1. audit `server.restart` `{ forced, savedBaseUrl }`;
2. flush the response;
3. after 250 ms, an orderly shutdown: stop accepting, close every browser WS
   with code **1012 Service Restart** (below the 4000 line, so
   `use-subshell-ws.ts` retries), close node sockets (the agent's backoff
   loop reconnects), then `process.exit(0)` (bun:sqlite releases on exit; the WAL is durable).

The gap is `RestartSec=5` on systemd and launchd's respawn on macOS (up to its
10 s throttle if two restarts land within 10 s). The SPA waits (§ 4.4).

### 3.4 The server log: one capped file on disk, nothing in memory

The console tailed the launchd log file on macOS and `journalctl` on Linux.
Neither exists in a container, and a headless install may run under anything.
The server now writes its own log file, **the same way on every platform**:
`<SUBSHELL_SERVER_DATA_DIR>/logs/server.log` (`paths.serverLog`), JSON lines
(`timestamp`, `level`, `message`, then context/metadata), **capped at
200 KB (204 800 bytes) and replaced when full** — at most one file, never a
growing history, never a copy in memory. The operator's direction
(2026-09-12): no in-memory log of any kind, HTTP request lines included.

The writer is a LogLayer file transport added beside the pretty stdout
transport. `@loglayer/transport-log-file-rotation` (`filename`, `size:
"200k"`, `maxLogs: 1`) is the intended one, **but whether it works under Bun
and inside a `bun build --compile` binary is unverified** (it wraps
`file-stream-rotator`, a Node library). The plan opens with a spike: a
script under `bun` and the same code compiled must both write, rotate at the
cap and delete the rotated file. If either fails, the fallback is a
`LoggerlessTransport` subclass of our own (`utils/log-file.ts`,
`CappedFileTransport`): append a JSON line with `appendFileSync`; when the
file's size would exceed the cap, truncate it and start over. Roughly forty
lines, no dependency, and exactly the "replaced when full" semantics asked
for. Either way the file is created 0600 in a 0700 directory, like the pane
logs, and the API reads it the same way.

**Level policy, and the debug option.** The stdout transport (what launchd
or journald collects) stays at `info`. The file transport carries the
*effective* level: `info` by default, `debug` when **debug logging** is on.
HTTP request/response lines (the Elysia plugin's `autoLogging`) are emitted
at `debug`, so they reach the file only in debug mode and never reach the
manager's log at all — "off by default for http". The polled routes
(`/api/admin/status`, `/api/admin/server`, `/api/admin/server/logs`,
`/api/setup/status`, `/api/settings/public`, `/ws`, `/ws/node`) are in the
plugin's `ignore` list, or a debug session would fill 200 KB with its own
polling. `BACKEND_LOG_LEVEL`, unused today, is removed.

Debug logging is an **instance setting** (`settings` row `debug_logging`,
absent = off), read at boot once the database is open and **applied live**
when toggled — the transport's `level` is flipped, no restart. The
environment can force it on for a headless box or for the lines before the
database opens: `SUBSHELL_DEBUG_LOGGING=1`, in the environment or in
config.env; while set, the setting is read-only and the view says so
(`logging.source: "process env"`).

Two routes:

- `GET /api/admin/server/logs?lines=200` → `{ lines: { ts, level, message,
  data? }[]; file: string; bytes: number; capBytes: 204800 }`. Reads the
  file (at most 200 KB by construction), parses each JSON line, returns the
  last `lines` (1..1000, default 200), oldest first. A line that is not JSON
  (a partial write at the cap) is returned as `{ level: "raw", message }`.
- `PUT /api/admin/server/logging` body `{ debug: boolean }` → the § 3.1
  view. **409 `LOGGING_FROM_ENV`** while `SUBSHELL_DEBUG_LOGGING` is set.
  Audits `server.logging.update` `{ from, to }`.

What this deliberately does not keep: history past one file. The recovery
screen reads the same file (§ 5.3), so the pre-boot lines a person needs
when the server will not start are there as long as they fit in 200 KB; the
manager's own log (`service.logPath` / `service.logHint`) is named in the
view for anything older.

Disclosure note for `docs/security.md`: an admin can now read the server's
log from a browser. In debug mode it holds request paths, and `GET
/install.sh?key=nsk_…` puts a setup key in one; the security doc already
records that setup keys land in access logs, and an admin can mint setup
keys anyway, so this widens nothing — but it is a new reader of that text
and is stated as such. The file is 0600 under the data directory, the same
posture as the pane logs, and it is deleted by reset with the data directory.

### 3.5 Nothing else moves to HTTP

Stop, start, install, uninstall, reset: no route. Each leaves the server
unreachable, which is the corollary in § 2. `subshell-server service <verb>`
remains for the headless operator, and the assistant for the desktop one.

## 4. SPA: the Service page, restart, About

### 4.1 `/settings/service` and the Service card

A seventh child of the Server Settings group: `{ to: "/settings/service",
label: "Service", icon: Power, short: "Svc" }`, gated by the group as every
child is. The label is "Service" and not "Server" because the control-plane
host's node row is named "Server" by default (the inventory notes an admin
already saw that word twice on `/nodes`) and because every card on the page
is about the running process: where it listens, who supervises it, where it
writes, what it logged. The route file follows the `settings_.status.tsx`
shape: the admin gate, composition, a Refresh button inside the admin branch;
data in `hooks/use-server-deployment.ts` (`GET /api/admin/server`,
`refetchInterval: 15_000`); cards in `components/service/`.

**Service card.** One line of state — *Running under launchd as pid 4812
since 10:42 · starts at login* — or *Running, not supervised* with
`restart.reason` under it. Then **Restart server** (§ 4.4). Under systemd the
line reads *Running under systemd*; a `paneSafety` of `kills` or `unknown`
adds an amber sentence: *Restarting will close every running subshell;
reinstall the service definition to fix this.*

### 4.2 Addresses card

The four fields, labelled as the console labelled them (Port, Bind address,
Public base URL, Other addresses browsers will use), seeded from
`settings[KEY].saved`, with `problems[].reason` rendered under a field as the
console did. A field whose `source` is `process env` renders read-only with
*Set by the environment (`HOST`); change it there.* **Save** PATCHes only the
fields the person touched; `warnings` render under the form; `CONFIG_INVALID`
lands under its field. After a save the card shows the § 3.1 view's
`restartRequired` state as a strip across the top: *Saved. Restart the server
to apply.* with a Restart button — the same strip appears when the view says
`restartRequired` for any other reason (a hand edit), so the page tells the
truth about the file rather than about its own last action. Passkey note
under Public base URL, unchanged from the console: changing it moves where
passkeys work.

### 4.3 Locations card

Read-only, monospace: config file (with *missing* when `!exists`), data
directory, database, pane logs, node artifacts, service definition, server
log (`paths.serverLog`), and the service manager's own log (the launchd
path, or the `journalctl` sentence). This is the console's Details
list without the Reveal buttons: the SPA cannot open Finder, and a person on
a headless box wants the string to paste, which is what a monospace value
with a copy affordance gives them.

### 4.3a Server log card

The last 200 lines of `paths.serverLog` over `GET /api/admin/server/logs`,
monospace, level-coloured, refreshed every 5 s while the card is mounted,
sticking to the bottom only if it was there. Its header carries a **Debug
logging** switch bound to `PUT /api/admin/server/logging` — off by default;
on, the file carries debug lines and every HTTP request — with the sentence
*Debug logging writes every request to the log file. It is capped at 200 KB
and replaced when full.* under it, and *Set by the environment
(`SUBSHELL_DEBUG_LOGGING`)* in place of the switch while the env forces it.

### 4.4 Restart, and an address that changes

Pressing Restart opens a confirm: *Restart the server? Running subshells
keep running; open terminals reconnect in a few seconds.* (or the
pane-killing variant with `force`). On 202 the page enters a **Restarting…**
state owned by `hooks/use-server-restart.ts`: it records the current
`bootedAt` from `admin/status`, then polls `GET /api/admin/status` every 1.5 s (the route that carries `bootedAt`)
(the query layer's unbounded network retry already covers the outage; the
existing offline banner shows *Can't reach the subshell server, retrying…*
as it does for any outage, and this hook does not fight it). The wait ends
when `admin/status` answers with a different `bootedAt`, or after 60 s with
*The server has not come back. Check the service where it runs.*

If the saved `APP_BASE_URL` origin differs from `window.location.origin`,
the Restarting state says so before the press and after it: *The server will
come back at `http://10.0.0.5:3090`.* with that address as a link, because
this page will not be able to see it return. In the desktop shell the Rust
poll re-points the window (§ 5.2) so the link is never needed there, but it
is shown regardless — the sentence is true in both.

### 4.5 About, for everyone

The user menu in the sidebar footer gains **About Subshell**: a dialog with
the instance name, *Server 0.2.0*, and — when `isDesktop()` — *Subshell
Server 0.2.0* from the UA marker's version; the licence summary and the
Website / Licence / company links from `legal.ts`, which the SPA already
holds. Not admin-gated: a person asking what this is should not need a role.
The macOS menu's native About box stays (it is free); Linux gets this dialog
where it had the console's About.

### 4.6 Desktop-only affordances

Three, each `isDesktop()`-gated, each a deep link naming a screen:

- **General → Reset this machine…** (exists): invoke renamed
  `desktop_open_assistant({ screen: "reset" })`.
- **Service → Update card**, shown when the UA marker's bundled server
  version is newer than `serverVersion` (§ 5.4): *Subshell Server includes
  server 0.3.0; this instance is running 0.2.0.* → **Update…** →
  `desktop_open_assistant({ screen: "update" })`.
- **The sidebar server pill** (exists): *Server running* → navigates to
  `/settings/service` for an admin, inert otherwise; *Server unreachable* →
  `desktop_open_assistant()` (the recovery screen).

## 5. Subshell Server, the app, after

### 5.1 Two windows

| Window | Page | Why it exists |
|---|---|---|
| `wizard` (label unchanged; the page is "the assistant") | `ui/dist`, bundled, `tauri://` | Everything in § 2 categories 1–2: first run, recovery, update, reset. Renders with the server down. The only page granted CLI-driving commands. |
| `main` | the server's SPA over loopback | Everything else. |

The console window, `capabilities/console.json`, `ui/index.html`'s five
sections and `ui/src/console/*` are deleted. Modules the assistant still
needs move to `ui/src/assistant/`: `config-form*.ts` (the first-run
"Customize…" link), `logs.ts` (the recovery tail), `tmux-warning.ts`,
`reset-view.ts` (now a screen), `result-strip.ts`. The 900×640 window
geometry and the sidebar go with the console.

### 5.2 Boot, and the poll that used to live in the console

`boot_window(&Probe)`:

```
probe.next == Ready            → Main   (open_main_now)
otherwise                      → Wizard (whose page picks first-run or recovery by `onboarded`)
```

The R6 property survives and improves: a machine set up entirely from the CLI
opens the **dashboard** on its first app launch, because the first probe
answers `ready`. `mark_onboarded` is still the single writer of the flag,
still set only by a `ready` probe; `onboarded` now means only "which family
of assistant screens" when the probe is not ready.

The console's page ran the 5 s `desktop_probe` poll, and the tray's enabled
state and the address the app knew both hung off it. That moves to Rust:
`control::watch`, one thread, `probe_now` every 5 s while the app runs,
skipped while a native action is in flight (`ACTION_IN_FLIGHT`, an
`AtomicBool` the setup/service/install/reset commands hold). Two duties:

- `tray::set_server_ready(probe.next == Ready)`, as `desktop_probe` did;
- **re-point `main`** when the probe is ready and `Probe::origin()` differs
  from the window's current origin — the case the inventory found unhandled:
  a port changed from the SPA and restarted leaves a window fetching a dead
  port. `windows::open_main`'s existing navigate-on-mismatch path is called,
  which also re-arms the origin pin.

It never raises the assistant. A server that goes away while the dashboard is
open shows the SPA's own offline banner; the person reaches recovery through
the pill, the tray or the Dock, all of which go through `open_home` (§ 5.5).

### 5.3 The assistant's screens

The first-run screens are unchanged (Welcome, Install tmux, Set Up Your
Server → Setting Up…, spec 2026-09-11 § 5). Added, all in the same frame,
selected by `screensFor(probe, onboarded)` in `wizard-state.ts`:

**Recovery** (`onboarded && next != ready`). One screen, whose title is the
step's: *No Server Found* (`no-server`), *Your Server Isn't Responding*
(`unreachable`), *Your Server Needs Its Configuration* (`init`), *Your Server
Isn't Installed as a Service* (`install-service`), *Your Server Is Stopped*
(`start`). One primary action per step (Choose subshell-server… / Retry /
Set up / Install and start / Start), the tmux gate as today, a ghost **Show
Details** disclosure holding the pre-boot facts (binary and its rung, config
file, service definition, manager state and detail, log location) and the
server log file (`desktop_logs` now reads `paths.serverLog` from `status
--json`, the same file on every platform, falling back to the launchd
file/journal only when the path is absent), and the last action's verbatim
output when there is one. Footer link: *Reset this Mac…* → the Reset screen.
The moment a probe answers `ready`, the content fades to *Opening your
dashboard…* and `open_main` runs once, exactly as Setting Up… does.

**Update Server** (reached from the SPA deep link, or from Recovery when
`serverChoice == upgrade-available`). *Update Your Server* — *Subshell Server
includes 0.3.0; this Mac is running 0.2.0.*; the pane-safety sentence when
`paneSafety != keeps`; **Update and restart** → `desktop_install_server`
(stops the managed service first, as today) then `desktop_service("restart")`
→ the ready path → dashboard. **Not now** returns to wherever the person
came from (the dashboard, if it exists).

**Reset** — the existing takeover, as a screen. Entry from the SPA's danger
card (`desktop_open_assistant({ screen: "reset" })` → `reset::arm_and_raise`,
unchanged: the plan is stashed from a fresh probe, the hostname is typed into
this page's box, the five deletion paths come from `status --json`), and from
the Recovery footer. The chain's last acts still leave the assistant standing
and close `main` — with one window fewer there is no console to close last,
and the zero-window hazard (N2) is now simply "never close the wizard from
inside the chain".

### 5.4 Telling the SPA a newer server is bundled

Only the app knows its bundled server version. The UA marker grows one
optional group: `SubshellDesktop/0.2.0 (macos; p=1; b=0.3.0)`, where `b` is
the version `bundled_version()` reports. `parseDesktopUA` reads it as
`bundledServer?: string`; the regex tolerates its absence so Subshell Client
(no marker at all) and older shells are unaffected, and `DESKTOP_PROTOCOL`
stays 1. The Service page's Update card compares `b` to `serverVersion` with
the protocol package's `semverLt`.

### 5.5 Tray, menu, and one opener

The tray menu becomes: **Open Subshell Server**, a separator, a check item
**Keep Running in Menu Bar** (macOS) / **Keep Running in Tray** (Linux; the
tray only exists where the StatusNotifier probe says it is drawn, so the item
needs no unsupported state), a separator, **Quit**. "Open Dashboard" and
"Manage server…" are gone. The check item reads and writes `close_to_tray`
directly in Rust, which retires `desktop_settings` and
`desktop_set_close_to_tray` as commands. The macOS menu bar loses *Manage
server…*; *Server Settings ⌘4* stays and now reaches the Service page too.

Every opener — tray item, left-click, Dock reopen, single-instance, the menu
when `main` is absent, the SPA pill — calls one function:

```
open_home(app):  probe_now(); if ready → open_main_now() else → open_assistant(None)
```

`open_manage_window` is deleted. `desktop_open_console` is renamed
`desktop_open_assistant(screen: Option<"reset" | "update">)`; with no screen
it is `open_home`'s "else" branch forced, which is what the pill wants when
the SPA can see the server is unreachable.

### 5.6 The IPC boundary after

| Window | Commands |
|---|---|
| `wizard` | `desktop_probe`, `desktop_setup`, `desktop_install_tmux`, `desktop_set_server_bin`, `desktop_service`, `desktop_install_server`, `desktop_logs`, `desktop_open_path`, `desktop_arm_reset`, `desktop_reset`, `desktop_open_main`, `desktop_open_tmux_docs`, `desktop_about`, `desktop_open_web`, plus `dialog:allow-open`, `dialog:allow-ask` |
| `main` | `desktop_open_assistant`, `desktop_shell_ready`, `desktop_notify`, window dragging — over loopback only |

Deleted commands: `desktop_init` (Addresses is the SPA's; first-run
customization rides `desktop_setup`'s payload), `desktop_open_control_plane`,
`desktop_settings`, `desktop_set_close_to_tray`. `main` keeps exactly three
app commands; the deep link still cannot execute anything: raising the
Update screen performs one read-only probe, and the update itself is a press
inside the bundled page. `ipc-acl.test.ts` is updated to the new table and
keeps asserting the three-way (page ↔ toml ↔ capability) equality.

## 6. Subshell Client and the node agent

### 6.1 The agent reports how it runs

`ready` gains one optional field, `runtime`, computed once per connect (one
`queryService` spawn, which the agent already knows how to do):

```ts
runtime?: {
  startedAt: string;                 // ISO, this process
  supervised: boolean;               // service.state === "running" && service.pid === process.pid
  service: {
    manager: "launchd" | "systemd" | null;
    installed: boolean; definitionPath: string | null;
    state: string; pid: number | null; enabled: boolean | null;
    paneSafety: "keeps" | "kills" | "unknown";
  };
  configPath: string;                // ~/.config/subshell/config.json
  logPath: string | null; logHint: string | null;
  tmuxPath: string | null;
  binaryPath: string;                // selfInvoke's command, resolved
}
```

`parseNodeEvent` checks required fields only, so the field is additive and
`NODE_PROTOCOL_VERSION` does not move. The plane keeps it on the live
connection (`conn.agent.runtime`), never in the `nodes` table: these are
facts about a running process, and when the node is offline they are stale
by definition.

### 6.2 The plane shows it

`GET /api/nodes/:id` gains `runtime` (the § 6.1 object) when the node is
online **and the viewer can configure it** (owner or `edit`, the existing
`nodeCanConfigure`). A `view` grantee can launch on a node; they do not need
the path of its config file. `local` reports nothing here — the host's facts
are the Service page's.

The SPA node detail (`routes/nodes_.$id.tsx`) gains a **Runtime** card,
online only: *Up since*, *Supervised by launchd (pid 511) · starts at login*
or *Not supervised*, *Agent binary*, *Config file*, *Data directory*, *Log*
(path or journal sentence), *tmux* (path, or the amber *not found: this node
accepts no launches*). Below it, **Restart agent** (§ 6.3).

### 6.3 Restart a node from the plane

A new signed command, `{ type: "restart" }`, no payload. The agent answers
`result { ok: true }` then, 250 ms later, exits 0; its service definition
(`Restart=always` / `KeepAlive=true`) respawns it and the backoff loop
reconnects. It refuses `{ ok: false, error: "not supervised" }` when
`runtime.supervised` is false, and — mirroring the server — refuses
`"kills panes"` when `paneSafety != keeps` unless the claim carries
`force: true`. An agent older than this command answers `unsupported` through
the existing default branch.

`POST /api/nodes/:id/restart` body `{ force?: boolean }`: cookie only; owner
or `edit`; `local` → 400 (*use the server's own restart*); offline → 409
`NODE_OFFLINE`; `unsupported` → 409 `NODE_AGENT_TOO_OLD`; `not supervised` →
409 `NODE_NOT_SUPERVISED`; `kills panes` → 409 `NODE_RESTART_KILLS_PANES`.
Audit `node.restart` `{ forced }`. The SPA's waiter watches the node's
`status` flip offline then online (the `/nodes` query at 1.5 s while
waiting), 60 s cap, same copy as § 4.4.

### 6.4 The node window becomes an assistant

Same frame (spec 2026-09-11 § 3), same window size as the server's
assistant (1024×720, fixed), screens by `screensFor(probe, settings)` in a
pure `ui/src/lib/node-assistant-state.ts`:

| Screen | When | One decision |
|---|---|---|
| **Connect to a Server** | no plane URL stored | the URL field → **Open** (`node_open_plane`); *Open in browser instead* as a ghost |
| **Install the Agent** | `no-agent` | **Install** (bundled) / **Choose an existing agent…** / **Retry** |
| **Enroll This Mac** | `not-enrolled` | Server URL (prefilled from the plane URL), setup key, name → **Enroll** (two-phase confirm unchanged); the tmux gate |
| **Start the Node Service** | `no-service` / `stopped` / `offline` | **Install and start** / **Start** / **Restart** as the step dictates; Show Details with the local facts, the log location, the last output |
| **Connected** | `online` | *This Mac is enrolled as **devbox**.* **Open Subshell Client** (the plane window). Under a disclosure: *Change server…* (plane URL), *This node reports to X* with **Repoint** when it diverges, *Re-enroll…*, *Update the agent to 0.3.0* when `upgrade-available` |
| **Reset** | from the Connected disclosure and the Start screen's footer | the approved client reset (2026-09-11), built here rather than into the card page it was specified against |

Startup is unchanged: with a plane URL the plane window opens, and the
assistant opens only where the tray gives it no route home
(`node_window_has_a_route_home`). Tray: **Open Subshell Client**, **This
Machine…**, the **Keep Running…** check item, **Quit**; `node_settings` and
`node_set_close_to_tray` retire as the server's did. `node_about` and
`node_open_web` stay for the frame's footer line, because the plane window
carries no marker and the SPA About dialog cannot name this app.

### 6.5 The client reset

`2026-09-11-native-reset-both-desktop-apps-design.md` is approved and its
client half is unbuilt (its plan has 41 open boxes and no closed ones). This
spec does not change what the reset does or the guards it carries; it changes
the page it is a screen of. The companion plan executes that plan's client
tasks against the assistant layout in one phase, so the card page is never
built only to be replaced.

### 6.6 What is not moved: updating the agent from the plane

The node page's *Update the agent* installs the app's bundled sidecar — a
local file the plane never sees. The plane-side equivalent, an agent that
downloads `subshell-node-cli-<triple>` from its own plane and replaces
itself, is real and wanted (the `NODE_CLOSE_UPDATE_REQUIRED` close today
just tells a stale node to die), but it needs a download credential a node
does not have — a node key can do nothing on REST by design (security §5.5)
— so it is a one-time token or a WS byte stream, and either is its own spec.
The assistant keeps the sidecar path; the SPA node detail shows *below
minimum* as it does today.

## 7. Contracts, complete

### 7.1 Server routes (`apps/server/api/src/api/admin-server/`)

- `get-server.route.ts` — `GET /api/admin/server` → § 3.1, `operationId: getServerDeployment`.
- `patch-config.route.ts` — `PATCH /api/admin/server/config` → § 3.2, `operationId: updateServerConfig`.
- `restart.route.ts` — `POST /api/admin/server/restart` → § 3.3, `operationId: restartServer`.
- `logs.route.ts` — `GET /api/admin/server/logs` → § 3.4, `operationId: readServerLogs`.
- `logging.route.ts` — `PUT /api/admin/server/logging` → § 3.4, `operationId: updateServerLogging`.
- `index.ts` — composes the five under `/api/admin/server`; registered in `adminRoutes`.

Shared: `services/server-deployment.ts` (`collectDeployment()` building
§ 3.1 from `collectStatus` + `queryService` + `isSupervised(service, pid)`,
the latter a pure exported function), `services/server-restart.ts`
(`scheduleRestart(deps)` — the orderly shutdown, injectable so tests never
exit), `commands/configure.ts` (`applyConfig` extracted), `utils/log-file.ts` (the capped file transport or the rotation transport behind one `serverLogFile` object, plus `readServerLogTail`), `services/logging-preference.ts` (`applyDebugLogging`, `debugLoggingSource`).

Audit actions added: `server.config.update`, `server.restart`, `server.logging.update`, `node.restart`.

### 7.2 Node protocol (`packages/subshell-protocol/src/node-frames.ts`)

- `ready.runtime?` per § 6.1 (type + `parseNodeEvent` accepting it when shaped, ignoring it otherwise).
- Command `{ type: "restart"; force?: boolean }` in the signed-command union.
- Result errors `"not supervised"`, `"kills panes"` as named constants beside `unsupported`.

Agent: `commands/restart.ts`, `daemon.ts` computes `runtime` in `readyEvent`
(async now; `queryService` once). Plane: `node-ws-handler.ts` keeps
`runtime` on `conn.agent`; `api/nodes/restart-node.route.ts`; `node-view.ts`
adds `runtime?` to the detail view with the access filter.

### 7.3 Desktop (server app)

Rust: `boot_window` per § 5.2; `control::watch` + `ACTION_IN_FLIGHT`;
`open_home`; `desktop_open_assistant`; tray check item; deleted commands per
§ 5.6; `windows.rs` loses `open_console`, `tuck_console`,
`open_manage_window`; `reset.rs` closes `main` and never the wizard.
TypeScript: `wizard-state.ts` gains `screensFor(probe, onboarded)` with the
Recovery/Update/Reset screens and `recoveryTitle(step)`; `ui/src/assistant/`
holds the moved modules; `lib/desktop.ts` (SPA) parses `b=`.

### 7.4 Desktop (client app)

Rust: tray check item; `node_settings`/`node_set_close_to_tray` deleted;
window 1024×720 fixed; the reset commands from the 2026-09-11 spec.
TypeScript: `lib/node-assistant-state.ts` (`screensFor`, pure), the frame
components, the six screens; `app.tsx` becomes the frame host.

## 8. Testing

**API** (`bun test`, `apps/server/api`):
- `isSupervised`: running + same pid → true; different pid, not running,
  null pid → false.
- `GET /api/admin/server`: cookie admin 200 with the full key set asserted
  (so a field cannot be added without a decision, the `settings/instance`
  pattern); bearer 403; non-admin 403; `running` ≠ `saved` ⇒
  `restartRequired`.
- `PATCH …/config`: byte-identical file against `configure` for the same
  input; each `validateValue` refusal surfaces as 400 with the CLI's
  sentence; `process env` key → 409 naming the variable; untouched keys
  preserved verbatim including `BETTER_AUTH_SECRET`; audit row with changes
  and no secret in metadata.
- `POST …/restart`: unsupervised → 409 and `scheduleRestart` not called;
  `paneSafety: kills` without force → 409, with force → 202; supervised →
  202, audit row, `scheduleRestart` called once with the injected exit.
- `GET …/logs`: reads the file's last N JSON lines, `lines` clamped, a
  non-JSON line comes back as `raw`; the transport (whichever the spike
  chose) caps the file at 204 800 bytes and replaces it.
- `PUT …/logging`: flips the transport level live and persists the setting;
  409 while the env forces it; audit row.
- Node: `POST /api/nodes/:id/restart` — each 409 path, `local` 400, `view`
  grantee 403, happy path sends the signed `restart` command and audits.
  `GET /api/nodes/:id` includes `runtime` for owner/`edit` online, omits for
  `view` and offline.

**Protocol / agent**: `parseNodeEvent` accepts `ready` with and without
`runtime`, drops a malformed one; `execRestart` refuses when unsupervised and
calls the injected exit when not.

**SPA** (`bun test`, `apps/server/web`): the Service route's gate; the
Addresses form renders env-sourced fields read-only and PATCHes only touched
fields; the restart waiter resolves on a changed `bootedAt` and times out;
`parseDesktopUA` with and without `b=`; the Update card's visibility from
`b` vs `serverVersion`; About dialog shows the shell version only under the
marker; sidebar tests updated for the seventh child.

**Desktop server** (`bun run rust:check`, `cd apps/server/desktop && bun run
test`): `boot_window` picks Main on a ready probe and Wizard otherwise (the
R6 test rewritten to its new, stronger claim); `screensFor` yields first-run
screens when `!onboarded`, Recovery when `onboarded && !ready`, nothing when
ready; `recoveryTitle` per step; `ipc-acl.test.ts` against the § 5.6 table
and "no page invokes a deleted command"; the watch's re-point decision as a
pure function (`origin_changed(current, probe)`).

**Desktop client**: `screensFor` per § 6.4; `ipc-acl.test.ts` updated.

**By hand, once** (recorded in the plan): change the port from the Service
page in the desktop window, restart, and watch the dashboard re-point;
same from a browser tab and follow the link; restart a headless Linux node
from the plane and see it return.

## 9. Docs and housekeeping

- `apps/server/desktop/AGENTS.md`: rewrite "The three windows" as two,
  delete "The console is five sections behind a sidebar", add the watch and
  `open_home`, update the IPC table.
- `apps/client/desktop/AGENTS.md`: the node window is an assistant; the
  screens; the deleted commands.
- `apps/server/api/AGENTS.md`: the admin-server routes; `applyConfig` is the
  one config writer; the capped log file and the debug toggle; the restart mechanism and why
  supervision is detected from the manager, not a marker.
- `apps/node/agent/AGENTS.md`: `runtime` in `ready`; the `restart` command.
- `.claude/rules/security-context.md` and `docs/security.md`: a short "The
  server manages itself on an admin's request" paragraph — config.env writes
  and self-restart are admin-cookie acts, audited; the log tail is a new
  reader of request paths; node restart is a plane→node lifecycle command,
  no new trust (the plane already runs arbitrary launches there).
- Root `AGENTS.md`: nothing structural changes; the word "console" leaves
  the server-desktop row of the "What each app is" table.
- Changesets: `@internal/server` (minor: Service page, four routes, node
  restart), `@internal/desktop-server` (minor: dashboard-first boot, the
  console is gone), `@internal/node` (minor: runtime report, restart),
  `@internal/desktop-client` (minor: the assistant). Never
  `@internal/server-web`.

## 10. Non-goals

- Stop, uninstall, start or reset the server over HTTP (§ 2 corollary).
- Setting `DATABASE_PATH` from the SPA.
- Log history beyond the one 200 KB file (the service manager's log is
  named for that).
- Any in-memory copy of log lines.
- Agent self-update from the plane (§ 6.6).
- Persisting node runtime facts in the database.
- A UA marker for Subshell Client's plane window (it is granted nothing by
  design, and stays that way).
- Revealing paths in Finder from the SPA.

## 11. Decisions taken here, for the operator to overrule

- **Supervision is inferred from the manager's pid, not from an env marker
  in the unit/plist.** A marker would be false the moment someone ran the
  binary by hand with the marker exported, and true only after
  `service install` rewrote every existing definition; the pid check is
  true exactly when exiting is a restart.
- **The server log is one 200 KB file under the data directory, replaced
  when full; nothing is kept in memory** (operator direction 2026-09-12).
  Uniform across launchd, systemd, containers and hand runs; the same file
  serves the SPA and the native recovery screen. The rotation transport's
  Bun compatibility is a spike, with a forty-line fallback of our own.
- **Debug logging is off by default, is the only way HTTP request lines are
  written, and is toggled live from the Service page** (persisted as a
  setting; `SUBSHELL_DEBUG_LOGGING=1` forces it for headless or pre-database
  use). The manager's stdout log stays at `info` regardless.
- **The page is called "Service".** "Server" collides with the default node
  name; every card is about the running process.
- **The tray preference is a check item in the tray menu**, not an SPA
  toggle. It is the one preference the app owns, it needs no new grant to the
  remote window, and the menu is where the behaviour it governs lives.
- **Stop stays out of the SPA.** A page that can stop the server it is
  served from leaves a headless operator with nothing; restart is the act
  that brings the server back.
- **The client keeps its native About footer**; its plane window carries no
  marker, so only the native side can say "Subshell Client 0.1.3".
- **The client reset is built into the assistant**, not into the card page
  its spec described, so the intermediate page is never built.
