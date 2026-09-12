# Server supervision and autostart — design (2026-09-12)

The Subshell Server setup screen has one row that reads **"Start it in the
background, and at every login"**, and nothing can be done about it: it is a
sentence, not a control. This spec turns that sentence into two checkboxes,
gives each one a settings home, and builds the machinery underneath — most of
which does not exist yet.

**This document is written to be implemented by someone who has not read the
conversation that produced it.** Every decision is stated with its reason;
every string, path, command and file is named; every place the existing code
has to change is listed with what the change is. Where a fact could only be
established by running something, § 15 names the measurement and what to do
with either answer.

The operator's decisions, taken 2026-09-12 and not up for re-deciding here:

1. The row becomes **two checkboxes**, not one, because the codebase already
   separates the two facts (`installed` and `enabled` in `ServiceState`).
2. With "Start it in the background" unchecked, **the app runs the server** —
   as its own child, alive while the app is open, gone when it quits. Not
   "nobody runs it".
3. The settings home for the login toggle is **the SPA's `/settings/service`**.
   For the background toggle the SPA can only be a door (§ 6), because
   installing and uninstalling a service stay off the API by the standing rule.

## 0. The two boxes

| box | fact it controls | where it is stored | who reads it |
|---|---|---|---|
| **Start it in the background** | whether a service manager (launchd / systemd) runs the server, or the app does | the desktop app's `settings.json` (`supervision`), corrected by what is on disk (§ 4.1) | the desktop app only |
| **Start it at every login** | whether that service comes up at login | the service definition's own state: `UnitFileState` on systemd, the plist's LOCATION on macOS (§ 3.2) | the CLI, the server (`collectDeployment`), the SPA, the desktop app |

Both default **checked**. A person who presses Set Up without reading gets
exactly today's behaviour — `install`, `init`, `service install`, `start` —
byte for byte. The second box is **disabled while the first is unchecked**: a
server the app runs has no service to start at login, and the thing that
would bring it back is the app itself starting at login, which is a different
feature (§ 13).

## 1. What exists today (measured, with file references)

- **`apps/server/api/src/service.ts`** owns the service. `installService`
  writes the unit/plist and runs `systemctl --user enable --now` (Linux) or
  `launchctl bootout` + `bootstrap` (darwin). `controlService` handles
  `start|stop|restart` (`SERVICE_VERBS`). `queryService` returns
  `ServiceState`, which already carries **`enabled: boolean | null`** —
  `UnitFileState.startsWith("enabled")` on systemd and, on darwin, a regex
  over the plist text for `RunAtLoad=true` (`queryLaunchd`). Nothing WRITES
  that bit: `install` always enables, and there is no `enable`/`disable` verb.
- **`apps/server/api/src/cli.ts`** dispatches `service <verb>`;
  `SERVICE_COMMANDS = ["install","uninstall","status",...SERVICE_VERBS]`;
  `SERVICE_FLAGS` is a per-verb allowlist (`status: --json`,
  `restart: --force`); `USAGE` lists every verb.
- **`apps/server/api/src/services/server-deployment.ts`** builds the
  `GET /api/admin/server` view. `isSupervised(service, pid)` is
  `state === "running" && pid === process.pid`; `restart.available` equals
  it; `manager` is derived from the platform alone (`darwin → launchd`,
  `linux → systemd`), NOT from whether anything is installed.
- **`apps/server/api/src/api/admin-server/`** is one file per route
  (`get-server`, `patch-config`, `restart`, `logs`, `logging`), composed in
  `index.ts`; `schemas.ts` holds `DeploymentViewSchema`; `restart.route.ts`
  is the model for a cookie-admin, audited, 409-refusing act.
- **`apps/server/web/src/components/service/service-card.tsx`** already
  renders `enabled` — `supervisionLine` appends `· starts at login`. The
  type is `apps/server/web/src/types/server-deployment.ts` (`ServiceState`,
  `manager: "launchd" | "systemd" | null`). Tests:
  `components/__tests__/service-card.test.tsx` with the
  `deploymentView()` helper. E2E: `e2e/tests/16-server-service.spec.ts`,
  whose stack is hand-started (`installed: false`, "Running, not supervised").
- **`apps/server/desktop/src-tauri/src/control.rs`**: `Probe`, `ProbeStep`
  (`NoServer | Setup | Unreachable | Init | InstallService | Start | Ready`),
  `Probe::decide()`, `desktop_setup(port, host, base_url, trusted_origins)`
  running `SetupStep::{InstallServer, Init, ServiceInstall, Start}`,
  `desktop_service(verb: ServiceCommand, force)` → `service_now`,
  `ServiceCommand::{Install, Uninstall, Start, Stop, Restart}`,
  `boot_probe`/`boot_window`/`open_home`, `ACTION_IN_FLIGHT`/`ActionGuard`,
  `run(argv, timeout)` from `subshell_desktop_core::proc` — **bounded spawns
  only; nothing in either app keeps a child alive today.**
- **`decide()` has no steady state for "configured, running, no service":**
  `!installed → ProbeStep::InstallService`. That is the single fact that
  makes box 1 an architectural change rather than a checkbox.
- **`crates/desktop-core/src/settings.rs`** `Settings` (serde, `default`,
  camelCase): `binary_path`, `close_to_tray`, `open_at_login` (reserved,
  unused), `plane_url` (client-only, shared struct), `onboarded`, `zoom`.
- **`apps/server/desktop/ui/src/wizard.ts`** renders the setup screen:
  `planRows(p)` draws the three what-will-happen rows (the middle one is the
  literal string above with an empty detail), `startSetup()` calls
  `ipc.setup(configPayload)`, `checklist()` renders `setupRows()` during the
  run. `apps/server/desktop/ui/src/lib/wizard-state.ts` owns `setupRows`,
  `canSetup`, `screensFor`, `recoveryTitle`, `recoveryAction`,
  `ScreenId = "welcome"|"tmux"|"setup"|"recovery"|"update"|"reset"`,
  `SetupRowId = "tmux"|"server"|"config"|"service"|"running"`.
- **`apps/server/desktop/ui/src/lib/ipc.ts`** is the typed IPC contract;
  `ui/src/__tests__/ipc-acl.test.ts` pins it equal to
  `src-tauri/permissions/desktop.toml` and `capabilities/wizard.json`
  (`main.json` grants exactly `open_assistant`, `shell_ready`, `notify`).
- **`apps/server/desktop/src-tauri/src/reset.rs`** `Screen::{Home, Reset,
  Update}` is the closed enum `desktop_open_assistant` parses; the SPA's
  reset card is the model for "a served page names a SCREEN, never a verb".
- **`apps/server/desktop/src-tauri/src/lib.rs`** handles
  `RunEvent::ExitRequested` (prevented while close-to-tray is on and `main`
  exists) and `RunEvent::Reopen`; nothing handles `RunEvent::Exit`.
- **`subshell-server` with no subcommand boots the server in the foreground**
  (`cli.ts` `USAGE`: "run the server (boot path: no subcommand)"). That is
  what the app will spawn.

## 2. Decisions

- **D1 — Two facts, two controls, no conflation.** `installed` and `enabled`
  are already distinct in `ServiceState`; the UI stops pretending otherwise.
- **D2 — macOS "enabled" is a file LOCATION, not a plist flag** (§ 3.2). Both
  flag-based alternatives are wrong for a `KeepAlive=true` job.
- **D3 — The app is a real supervisor**, with the same contract a manager
  offers the server: respawn on any exit after 5 s, stop on quit, main pid
  only. That contract is what lets `POST /api/admin/server/restart` keep
  working unchanged (§ 4.7).
- **D4 — The server learns who runs it from its environment, verified by
  parentage** (`SUBSHELL_SUPERVISOR_PID === process.ppid`, § 4.7). A claim
  without the matching parent is ignored.
- **D5 — A service definition on disk outranks the stored preference.**
  If a unit/plist exists, the machine is in service mode whatever
  `settings.json` says, and the probe corrects the file (§ 4.1).
- **D6 — Nothing new is granted to the SPA window.** Its only new reach is
  one more member of the `Screen` enum. Install/uninstall/stop/start stay
  off the API (the standing rule of spec 2026-09-12 *Management in the
  dashboard*); the autostart toggle is admissible because it changes nothing
  about the running process (§ 3.6).
- **D7 — Default-on, opt-out.** Unchecked boxes are the minority path; the
  majority path is byte-identical to today.

## 3. Box 2 — "Start it at every login"

### 3.1 Linux (systemd)

- `enable`  = `systemctl --user enable subshell-server.service` — **never
  `--now`**; the running process is untouched.
- `disable` = `systemctl --user disable subshell-server.service` — never
  `--now`.
- `install --no-autostart` = write the unit, `daemon-reload`, then
  `systemctl --user start subshell-server.service` instead of `enable --now`.
  Success line: `Installed <path>; subshell-server is running (not enabled at login).`
  plus the existing lingering hint.
- `enabled` continues to read `UnitFileState.startsWith("enabled")`. After
  `install --no-autostart` it is `disabled`; after `enable` it is `enabled`.
- A masked unit refuses both verbs; surface `systemctl`'s words as today.

### 3.2 macOS (launchd) — the location rule

Two approaches were rejected, and the reasons must survive in code comments:

- **`RunAtLoad=false` is not enough.** The plist carries `KeepAlive=true`,
  and a `KeepAlive=true` job is started when loaded regardless of
  `RunAtLoad` (launchd.plist(5): "unconditionally keep the job alive").
  Switching `KeepAlive` to a dictionary form would break restart-by-exit,
  which `performRestart` relies on (`exit(0)` → respawn).
- **`launchctl disable gui/<uid>/<label>` is not enough either.** A disabled
  service refuses `bootstrap`, so "run it now but not at login" cannot be
  expressed; and the disabled mark lives in launchd's per-uid override
  database, survives `service uninstall`, and makes a later fresh `install`
  fail with launchd's generic EIO — a footgun `bootstrapDarwin`'s error text
  already hints at.

What launchd DOES document is that it auto-loads, at login, exactly the
plists in `~/Library/LaunchAgents/`. So:

| `enabled` | plist path | how it gets loaded |
|---|---|---|
| `true`  | `~/Library/LaunchAgents/dev.subshell.server.plist` (today's `plistPath(home)`) | launchd, at login |
| `false` | `<configDir>/subshell-server.launchd.plist` — the **session path** | `launchctl bootstrap gui/<uid> <path>` by `service start` / `install` |

- `enable`  = write the plist to the LaunchAgents path, then remove the
  session path. `disable` = the reverse. **Write the destination first, then
  remove the source**; a failed write removes nothing. The loaded job is
  untouched by either — a running job does not care where its file came from.
  (Implement with the existing `readFile`/`writeFile`/`removeFile` seams;
  no rename seam is needed.)
- **Exactly one of the two paths exists after any verb.** `install` writes
  the path the `autostart` flag selects and removes the other if present.
- `queryService` on darwin resolves `definitionPath` as: the LaunchAgents
  path if it exists, else the session path if it exists, else the
  LaunchAgents path (for the "would live at" answer) with `installed: false`.
  **`enabled` becomes `definitionPath === plistPath(home)`** when installed,
  `null` when not. Delete the `RunAtLoad` regex; it would now lie.
- `bootstrapDarwin` and every other `plistPath(deps.home)` inside the control
  verbs must bootstrap from **`state.definitionPath`**, not the LaunchAgents
  constant.
- `uninstallService` removes **whichever** path exists (both, if a bug ever
  left two), after `bootout`. Its "nothing installed" branch triggers only
  when neither exists.
- `serviceArtifactPath(platform, home)` (exported; the desktop app's
  `OpenTarget::service-definition` reveal uses it) gains a
  `configDir` parameter and returns the path that exists, else the
  LaunchAgents path.
- `<configDir>` is `serverConfigDir()` (`~/.config/subshell-server`), which
  `ServiceDeps.configDir` already carries. It is a reset deletion target; the
  reset chain uninstalls before it deletes, so the ordering holds.

### 3.3 CLI surface (`apps/server/api/src/cli.ts`, `service.ts`)

- `SERVICE_COMMANDS = ["install", "uninstall", "status", "enable", "disable", ...SERVICE_VERBS]`.
  `enable`/`disable` are NOT added to `SERVICE_VERBS`/`controlService` —
  they are authoring verbs, dispatched like `install`/`uninstall` to a new
  `setAutostart(deps, enabled: boolean): CliResult` in `service.ts`.
- `SERVICE_FLAGS.install = new Set(["--no-autostart"])`.
- `installService(deps, opts: { autostart: boolean } = { autostart: true })`.
- `setAutostart` refuses with exit 1 when nothing is installed
  (`nothing installed: no service definition at <path> (run \`subshell-server service install\` first)`
  — the same sentence `controlService` uses) and on an unsupported platform
  (the existing `unsupported()` text).
- Success lines (the manager is silent on success, so these are the only
  feedback): `subshell-server will start at login.` /
  `subshell-server will no longer start at login.`
- `USAGE` gains three lines:
  ```
  subshell-server service install    background the server (systemd user unit / launchd agent); --no-autostart to skip login
  subshell-server service enable     start it at login (does not touch the running process)
  subshell-server service disable    stop starting it at login (does not touch the running process)
  ```
- `serviceStateLines(state)` (the human `service status`) says
  `starts at login: yes|no|unknown` — check whether it already does and keep
  one line for it.

### 3.4 API — `POST /api/admin/server/autostart`

New file `apps/server/api/src/api/admin-server/autostart.route.ts`, composed
in `index.ts`. Modelled on `restart.route.ts`.

- `requireAdmin` (cookie only; bearer refused like every admin-server route).
- Body: `{ enabled: t.Boolean({ description: "Whether the installed service should start at login" }) }`.
- Refusals, all **409** with a new `BackendErrorCodes.AUTOSTART_UNAVAILABLE`
  (add to `packages/backend-errors` beside `RESTART_UNAVAILABLE`):
  - `manager === "app"` → `"This server runs with the Subshell Server app; start the app at login to have it back."`
  - `!service.installed` → `"No service is installed on this machine, so there is nothing to start at login."`
  - `enabled === null` → `"The service manager did not say whether this server starts at login."`
- Otherwise call `setAutostart(serviceDeps(), body.enabled)` synchronously
  (invariant 1 of the CLI: no await opens the boot graph). A non-zero
  `CliResult` is a **500** carrying the CLI's `err` verbatim (it is
  launchd's/systemctl's own words — the honest answer).
- **Audit only when the state changed**: `action: "server.autostart.update"`,
  `targetType: "server"`, `targetId: "service"`,
  `metadataJson: {"from": <bool>, "to": <bool>}`. A no-op is not an act.
- Response **200** `DeploymentViewSchema` — the fresh view after the write,
  as `PATCH config` and `PUT logging` do, so the SPA sets query data and
  never re-fetches to see what it did.
- `operationId: "setServerAutostart"`, `tags: ["admin"]`.
- **Factor `serviceDeps()`**: `collectDeployment` already builds
  `DEFAULT_DEPS({...})` inline (~line 225 of `server-deployment.ts`);
  extract and export it so the route and the view build the same deps.

### 3.5 Schema and types

- `schemas.ts` `service.manager`: `t.Union([t.Literal("launchd"), t.Literal("systemd"), t.Literal("app")])`, nullable as before.
- `apps/server/web/src/types/server-deployment.ts` `ServiceState.manager: "launchd" | "systemd" | "app" | null`.
- No new keys on the view: the existing key-set test in the `get-server`
  route tests stays true.

### 3.6 Why this route is admissible

`docs/security.md` § 11 says: "Stop, start, install, uninstall and reset have
no route. Each leaves the server unreachable, so a page the server serves is
the wrong place to drive them." Toggling autostart changes nothing about the
running process — it is a preference about the NEXT login. It is therefore
inside the rule, not an exception to it, and § 10 amends the paragraph to say
so explicitly rather than leaving the reader to infer it.

### 3.7 SPA — the switch on `ServiceCard`

- Under the supervision line, a `Switch` (the existing primitive) labelled
  **"Start at login"** with the description
  **"Brings the server back when you log in to this machine."**
- Checked = `service.enabled === true`.
- Disabled, with the reason rendered as muted text beneath, when:
  - `service.manager === "app"` → *"The server runs with the Subshell Server app. To have it back at login, start the app at login."*
  - `!service.installed` → *"No service is installed on this machine."*
  - `service.enabled === null` → *"The service manager did not say whether this server starts at login."*
- Toggling POSTs `{enabled}`; on 200 write the returned view into
  `SERVER_DEPLOYMENT_QUERY_KEY` (`queryClient.setQueryData`); on error show
  the message inline under the switch and revert the visual state. Put the
  mutation in `hooks/use-server-autostart.ts`; keep the card a renderer.
- `supervisionLine` keeps `· starts at login` — the switch is the control, the
  line is the fact; they agree by reading the same field.

## 4. Box 1 — "Start it in the background"

### 4.1 The setting

`crates/desktop-core/src/settings.rs` `Settings` gains:

```rust
/// Who runs the server on this machine: the platform's service manager, or
/// this app as a child process that lives and dies with it (spec
/// 2026-09-12 server-supervision). A PREFERENCE, corrected by the disk: a
/// unit/plist that exists puts the machine in `Service` mode whatever this
/// says, and the probe writes the correction back. Subshell Client never
/// sets it (the struct is shared for its FORMAT, like `plane_url`).
pub supervision: Supervision,
```

with `#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)] #[serde(rename_all = "kebab-case")] pub enum Supervision { #[default] Service, App }`.
Absent in an existing file → `Service` (the struct-level `#[serde(default)]`).

**Effective supervision** (`control.rs`, a pure function with a test):

```
fn effective_supervision(stored: Supervision, service_installed: Option<bool>) -> Supervision
  installed == Some(true)  → Service          // D5: disk wins
  otherwise                → stored
```

`desktop_probe` and `boot_probe` write the correction back when
`effective != stored` (one writer rule, like `mark_onboarded`).

### 4.2 The supervisor — `apps/server/desktop/src-tauri/src/supervisor.rs`

Tauri-free, single-consumer, so it lives in the app, not `desktop-core`
(the crate's own rule: an abstraction over one real consumer and one guess
costs more than it removes; `reset_guards` moved to core only when the
second app needed it).

**Contract** (the same one launchd/systemd give the server):

- `start()` — idempotent. If not running, spawn; either way the desired state
  becomes Running.
- `stop()` — desired state Stopped; terminate the child (§ "Stopping").
  Blocks until the child is gone or the bound expires. Idempotent.
- `restart()` — terminate the child; the loop respawns it at once (no 5 s
  wait for a restart the user asked for).
- `snapshot() -> Snapshot { desired: Running|Stopped, pid: Option<u32>, since: Option<Instant>, last_exit: Option<LastExit { code: Option<i32>, at: SystemTime }>, console_log: PathBuf }`.

**Loop** (one thread, spawned on first `start()`):

```
while desired == Running:
    child = spawner.spawn()            // § "Spawn"
    record pid, since
    status = child.wait()              // blocking
    record last_exit
    if desired != Running: break
    sleep(RESPAWN_DELAY = 5 s), interruptible by stop()/restart()
```

Parity with the unit's `Restart=always` + `RestartSec=5` +
`StartLimitIntervalSec=0`: **always respawn, every 5 s, no start limit.** An
EADDRINUSE crash loop under systemd is a 5 s loop; here it is the same, and
the probe surfaces it (§ 4.4) instead of a limiter hiding it.

**Spawn** (`argv` = the resolved server binary's argv — `ServerBinary.argv` —
with no subcommand, so the boot path runs):

- `env`: the app's environment, plus `PATH` = `shell_env::login_path()`
  (the same PATH every bounded spawn gets — a GUI's PATH is
  `/usr/bin:/bin:/usr/sbin:/sbin`, which loses a Homebrew tmux), plus
  `SUBSHELL_SUPERVISOR=subshell-desktop-server`,
  `SUBSHELL_SUPERVISOR_PID=<this app's pid>`,
  `SUBSHELL_SUPERVISOR_LOG=<console_log path>`.
- `cwd`: the config dir — the parent of `status --json`'s `configEnv.path`
  when the probe has it, else `~/.config/subshell-server`. The plist and unit
  both set `WorkingDirectory` to it for the reason recorded in `service.ts`
  (relative `DATABASE_PATH` and Bun's cwd-based `.env` lookup).
- `stdin`: null. `stdout`/`stderr`: **appended to one file, truncated on each
  spawn**, so it always holds the last run's console output — the crash you
  want to read — and is bounded by construction. Path (`console_log`):
  darwin `~/Library/Logs/subshell-server.log` (the same file the plist names,
  so `desktop_logs`' fallback needs no new rung); Linux
  `$XDG_STATE_HOME/subshell-server/console.log`, default
  `~/.local/state/subshell-server/console.log`, directory created 0700, file
  0600. `desktop_logs` on Linux learns this path as its fallback when
  `supervision == App` (today it names the journal, which has nothing).
- Process group: **do not create a new one.** The child stays in the app's
  group; nothing here sends group signals (see Stopping), so it does not
  matter, and a new session would detach the child from the tools a
  developer expects (`pgrep -P`).

**Stopping** — SIGTERM to **the pid only, never the process group**, then
`try_wait` every 100 ms up to `STOP_BOUND = 10 s`, then `Child::kill()`
(SIGKILL) as the last resort. `libc` is not a dependency of either crate and
is not to become one for this (the hostname precedent): send the signal as
one bounded spawn through `proc::run(["kill", "-TERM", "<pid>"], 2 s)`.
Killing only the main pid is what `KillMode=process` / `AbandonProcessGroup`
buy under the managers: each local subshell's tmux server is a CHILD of the
server, and a group kill would take every live pane down. **Panes survive the
app quitting** — that is a property the test in § 9 pins over an injected
spawner and the manual check in § 12 confirms for real.

**Orphans.** If the app is SIGKILLed, the child is reparented and keeps
running; the next app launch finds the port answering with no child of its
own. The probe treats that as `Ready` (the dashboard works) and the
supervisor does **not** adopt it (it has no `Child` handle and no right to
kill a process it did not start); the SPA shows "Running under Subshell
Server" only if that server's `ppid` still matches — it will not, so it shows
"Running, not supervised" with Restart disabled. Honest, and rare.

**Injected seam for tests**: `trait Spawner { fn spawn(&self) -> io::Result<Box<dyn ChildHandle>>; }`
with `ChildHandle { fn id(&self) -> u32; fn wait(&mut self) -> io::Result<ExitStatus>; fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>; fn kill(&mut self) -> io::Result<()>; }`
and an injected `terminate(pid)` and `sleep` so the state machine is tested
with no processes and no real time.

**Managed state**: `.manage(supervisor::Supervisor::new())` in `lib.rs`.

### 4.3 Lifecycle hooks (`lib.rs`)

- **Boot.** After `boot_probe`: if `effective_supervision == App` and the
  probe is not `Ready`, call `supervisor.start()`, then poll `probe_now`
  every 500 ms for up to `BOOT_START_GRACE = 5 s` waiting for `Ready`, then
  make the window choice from the LAST probe. A server that binds within a
  few seconds (the common case) lands on the dashboard exactly as a
  service-mode boot does; one that does not lands on recovery, whose Start
  is idempotent. The boot probe's `mark_onboarded` rule is unchanged.
- **`RunEvent::Exit`** (add an arm): `supervisor.stop()`. This is the one
  hook that runs on every path out of the process that Tauri controls — Quit
  from the tray, ⌘Q, the last window closing where close-to-tray is off. A
  hidden-to-tray app is still running, so its server keeps running: "while
  the app is open" means the process, not a window.
- **`ExitRequested`** guard: unchanged.
- **Reset** (`reset.rs`): step 1 ("stop") becomes `supervisor.stop()` when
  `effective_supervision == App` (there is no service to stop); the uninstall
  step stays — `uninstallService` on nothing installed is an exit-0 no-op.
  Step 6 additionally writes `s.supervision = Supervision::Service` (the
  default; a wiped machine is a fresh one). The restart at the end already
  passes through `RunEvent::Exit`, so the child is stopped before the
  process goes — pin the order in the code comment.
- **`watch.rs`**: unchanged. Its probe sees `Ready` when the child binds.

### 4.4 The probe (`control.rs`)

`Probe` gains:

```rust
/// Who runs the server here, AFTER the disk-wins correction (§ 4.1).
pub supervision: Supervision,
/// The app's own child, when it is the supervisor. `None` in service mode
/// and when the app has spawned nothing yet.
pub supervisor: Option<SupervisorReport>,
```

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct SupervisorReport {
    pub pid: Option<u32>,
    /// A sentence about the last exit, for the recovery screen:
    /// "exited with code 1 twelve seconds ago" — or `None` when it has
    /// never exited.
    pub last_exit: Option<String>,
    pub console_log: String,
}
```

`decide()` gains one branch, **after** the `configEnv.exists` check and
**before** the `service` checks:

```rust
} else if self.supervision == Supervision::App {
    if self.listening() { ProbeStep::Ready } else { ProbeStep::Start }
}
```

`probe_now` needs the setting to compute `effective_supervision`; give it
the stored value as a parameter (`probe_now(configured, stored_supervision)`)
— it stays pure. `desktop_probe`/`boot_probe`/`open_home`/`arm_and_raise`
pass `settings.get().supervision`.

`Probe.error` in app mode: when `supervisor.last_exit` is within the last
`RESPAWN_DELAY` and the code was non-zero, set
`error = Some("subshell-server exited with code N; see <console_log>")` so
the recovery screen names the crash loop instead of a bare "Stopped".

TS mirror (`ui/src/lib/ipc.ts`): `supervision: "service" | "app"`,
`supervisor: { pid: number | null; lastExit: string | null; consoleLog: string } | null`.

### 4.5 `desktop_service` in app mode

`service_now(settings, verb, opts)` where `pub struct ServiceOpts { pub force: bool, pub autostart: bool }`
(`force` only for `restart`, `autostart` only for `install`; both default
true/false as today's semantics imply — `autostart` defaults **true**).

When `effective_supervision == App`:

| verb | does |
|---|---|
| `start` | `supervisor.start()`; `ActionResult{ok:true, stdout:"subshell-server started."}` |
| `stop` | `supervisor.stop()`; `"subshell-server stopped."` |
| `restart` | `supervisor.restart()`; `"subshell-server restarted."` (`force` ignored: the app kills the main pid only, so panes are never at risk) |
| `install` | the mode switch to Service (§ 6.2), NOT a bare install |
| `uninstall` | refused: `Err("no service is installed; this server runs with the app")` |

`desktop_service` stays behind `ActionGuard`. Its TOML description gains
"…or, when this app runs the server, start/stop/restart that child."

### 4.6 `desktop_setup`

Signature: `desktop_setup(settings, supervisor: State<Supervisor>, port, host, base_url, trusted_origins, background: Option<bool>, autostart: Option<bool>)`.
Both default `true` (absent = today's chain). `InitPayload` in `ipc.ts`
gains `background: boolean; autostart: boolean`.

Steps:

```
InstallServer, Init,
if background:  ServiceInstall{autostart}, Start           // exactly today when autostart
else:           SetSupervision(App), SpawnChild              // write the setting, supervisor.start()
```

`SpawnChild` returns `ok:true, stdout:"subshell-server is running with this app."`;
the page's existing ready-wait (`startSetup`'s two extra probes at 1.5 s)
covers the bind. The `service` checklist row (§ 5) says what happened.

`ServiceInstall{autostart:false}` passes `--no-autostart`.

### 4.7 The server learns who runs it (`server-deployment.ts`)

```ts
/** The desktop app names itself here when it spawned this process (spec 2026-09-12 server-supervision). */
export const SUPERVISOR_ENV = "SUBSHELL_SUPERVISOR";
export const SUPERVISOR_PID_ENV = "SUBSHELL_SUPERVISOR_PID";
export const SUPERVISOR_LOG_ENV = "SUBSHELL_SUPERVISOR_LOG";
export const DESKTOP_SUPERVISOR = "subshell-desktop-server";

/** True only when the claimed supervisor IS this process's parent. */
export function appSupervised(env: NodeJS.ProcessEnv, ppid: number): boolean {
  return env[SUPERVISOR_ENV] === DESKTOP_SUPERVISOR && Number(env[SUPERVISOR_PID_ENV]) === ppid;
}
```

When `appSupervised(env, process.ppid)`, `collectDeployment` reports:

```
service: { manager: "app", installed: false, definitionPath: null,
           state: "running", pid: process.pid, enabled: false,
           paneSafety: "keeps", logPath: env[SUPERVISOR_LOG_ENV] ?? null,
           logHint: null, supervised: true }
restart: { available: true, reason: null }
```

`paneSafety: "keeps"` is a statement about the app, and the app earns it in
§ 4.2 (main pid only). `supervised: true` because the app respawns on exit
with the same contract as the managers — so **`POST /restart` is unchanged
and works**: `performRestart` exits 0, the supervisor sees the exit and
respawns after `RESPAWN_DELAY`.

**That restart takes 5 s, deliberately.** The supervisor cannot tell an
asked-for exit from a crash — both can be exit 0 — so a self-restart goes
through the same 5 s wait a crash does. This is `RestartSec=5` parity, the
SPA's restart waiter already tolerates systemd's 5 s, and `BOOT_DRIFT_MS` was
chosen with that gap in mind. Only the app's OWN `restart()` (§ 4.2, driven
by `desktop_service(restart)`) respawns at once, because there the app knows
it asked. Say both halves in a comment at `RESPAWN_DELAY`.

**Trust accounting** (goes in `docs/security.md`, § 10): the env var is a
claim any process could make. The parentage check means a forged claim only
"works" when the forger is literally the parent — a shell that set the
variables and exec'd the server — and then `restart.available: true` lets an
admin exit the server into a parent that will not respawn it. That is an
operator lying to themselves in a variable they own, on a host they already
control; it is the same class as editing `config.env` by hand, and it is
accepted. The desktop app is the only thing that sets these variables.

`queryService` is still called in app mode (for `installed`, to apply D5 from
the server's side too: a definition on disk with an app-supervised process is
a conflict worth a `detail` line, `"a service definition exists but this process was started by the app"`).

### 4.8 SPA rendering of `manager: "app"`

- `supervisionLine`: `Running under Subshell Server as pid N since HH:MM · stops when the app quits`.
- Restart button: enabled (the view says `available: true`); the confirm
  dialog's copy is unchanged (it speaks of "the manager respawns"; make it
  read "Subshell Server respawns it" when `manager === "app"` — one ternary).
- Autostart switch: disabled with the app reason (§ 3.7).
- The door button (§ 6.3).

## 5. The setup screen (`wizard.ts`, `wizard-state.ts`)

`planRows(p)` becomes four rows, the middle two interactive:

```
Install the server                       ~/.local/bin/subshell-server
[x] Start it in the background           runs as a launchd agent   |   runs as a systemd user service
[x] Start it at every login              (disabled + unchecked while the box above is unchecked)
Open your dashboard                      http://localhost:3080
```

- Checkbox state lives beside `form` in `wizard.ts`: `let background = true; let autostart = true;`
  reset with the form. Unchecking `background` **forces `autostart = false`
  and disables it**; re-checking `background` restores `autostart = true`
  (the default, not a remembered value — the box was disabled, not chosen).
- Detail text by platform (`p.platform`): darwin `runs as a launchd agent`,
  linux `runs as a systemd user service`. When `background` is unchecked the
  detail reads `runs while this app is open`.
- The login row's detail when disabled: `needs the box above`.
- Hint under the pair (muted, one line, shown only when box 1 is unchecked):
  `Quitting Subshell Server stops the server. Running subshells keep running.`
- `startSetup()` sends `{...configPayload, background, autostart}`.
- `setupRows(probe, addresses, choice: { background: boolean; autostart: boolean } = { background: true, autostart: true })`
  — the default keeps every existing caller and test valid; the `service`
  row becomes, by `choice`:
  - background+autostart: `{ label: "Background service", detail: "starts at login", done: installed && enabled === true }`
  - background only: `{ label: "Background service", detail: "not at login", done: installed }`
  - app: `{ label: "Runs with this app", detail: "stops when you quit", done: probe.supervision === "app" && probe.supervisor?.pid != null }`
  `checklist()` passes the live choice; `planRows` no longer reads the
  `service` row (it draws its own two).
- `canSetup` unchanged (tmux is still the gate; `init` and `service install`
  refuse without it, and the app-run server launches panes through it too).
- The e2e setup spec (`e2e/tests/01-setup-wizard.spec.ts`) drives the SPA's
  `/setup`, not this native screen — no e2e change here. Pin the rows with
  the existing `wizard-state.test.ts` style.

**The recovery screen in app mode**: `recoveryTitle("start")` stays "Your
Server Is Stopped"; `recoveryAction("start")` stays `{ label: "Start", kind: "start" }`
(the kind routes to `desktop_service(start)`, which § 4.5 makes the
supervisor). Add the `supervisor.lastExit` sentence and a "Show console log"
reveal (`OpenTarget::logs` already exists; point it at `consoleLog` in app
mode) under Show Details. A `Ready`-but-app-mode machine never shows
recovery, as today.

## 6. Switching later — the door, and the `supervision` screen

### 6.1 Why the SPA is only a door

Moving between modes installs or uninstalls a service, and both leave the
server unreachable for a moment — the exact thing the no-route rule keeps
off the API. So the SPA names a **screen** and the assistant does the work,
the pattern the reset card and the Update card already use.

### 6.2 `desktop_set_supervision` (new command, assistant-only)

`desktop_set_supervision(settings, supervisor, mode: Supervision, autostart: bool) -> Result<ActionResult, String>`,
behind `ActionGuard`, log-accumulating like `desktop_setup`, stop at first
failure:

- **Service → App**: `service_now(Uninstall)` (the CLI's stop+remove; the
  CLI warns on stderr when the definition would kill panes and that warning
  rides into the log verbatim), write `supervision = App`, `supervisor.start()`.
- **App → Service**: `supervisor.stop()`, write `supervision = Service`,
  `service_now(Install{autostart})`, `service_now(Start)`.
- **Service → Service with a different `autostart`**: `service_now(Enable|Disable)` only.
- **Same mode, same autostart**: `ok:true, stdout:"Nothing to change."`.

`ServiceCommand` gains `Enable`, `Disable` (TS `ServiceVerb` too).

### 6.3 The screen

- `Screen::Supervision` in `reset.rs` (`parse_screen` accepts
  `"supervision"`; `as_str` returns it). `ScreenId` and `isRequestedScreen`
  in the page gain it — a requested screen outranks the probe's family, the
  rule those two already state.
- Title **"How Your Server Runs"**; subtitle **"Change who starts it, and when."**
- Content: two radio rows —
  **"In the background"** — *"A launchd agent / systemd user service runs it, even when this app is closed."* with the nested **"Start it at every login"** checkbox;
  **"With this app"** — *"Runs while Subshell Server is open; quitting stops it. Running subshells keep running."*
  Seeded from the probe (`supervision`, `service.enabled`).
- Bottom bar: Back (to `home`), **Apply** (primary; disabled while nothing
  changed or while busy). Apply runs `desktop_set_supervision`, renders the
  verbatim log on failure exactly as setup does (`failureLine`), and on
  success returns to `home`, whose re-probe lands on ready → the dashboard
  (a Service→App switch has a bind wait; the ready handoff already tolerates
  it).
- Reachable from: the SPA door (below) and from the assistant's recovery
  Show Details (`"Change how it runs…"` link) — so a person on a machine with
  a broken service definition can move to app mode without a running server.

### 6.4 The SPA door

On `ServiceCard`, rendered **only when the SPA is in the desktop shell**
(the same `isDesktopShell()`/bridge check `reset-card.tsx` uses — the
`SubshellDesktop/…` marker; Subshell Client strips it, so the door never
appears there):

- manager launchd/systemd → outline button **"Run with the app instead…"**
- manager app → outline button **"Run as a background service…"**

Both call the bridge's `openAssistant("supervision")` (the existing
`desktop_open_assistant({screen})` wrapper — add `"supervision"` to its
screen type). Nothing else is granted to `main`; `main.json` is unchanged.

## 7. The three-way IPC contract

`ui/src/lib/ipc.ts`, `src-tauri/permissions/desktop.toml`,
`capabilities/wizard.json` — add all three or `ipc-acl.test.ts` names the
one you missed:

- **`desktop_set_supervision`**: permission `allow-desktop-set-supervision`,
  description: *"Switch who runs the server: install or uninstall the login
  service, or hand the server to this app as a child process, and set
  whether it starts at login. Leaves the server unreachable for a moment,
  which is exactly why it is assistant-only."*
- `desktop_setup` and `desktop_service` keep their names; their TOML
  descriptions are amended (§ 4.5, § 4.6).
- `main.json`: **no change**. The ACL test's "exactly three commands" pin
  must still pass.

## 8. Refusals and errors — one table

| where | condition | answer |
|---|---|---|
| CLI `service enable/disable` | nothing installed | exit 1, `nothing installed: no service definition at <path> (run \`subshell-server service install\` first)` |
| CLI `service enable/disable` | unsupported platform | exit 1, the existing `unsupported()` text |
| CLI `service enable/disable` (darwin) | destination write fails | exit 1, the fs error; source untouched |
| CLI `service install --no-autostart` (linux) | `systemctl --user start` fails | exit 1, `systemctl --user start … failed (exit N): <words>`; unit left on disk |
| `POST /autostart` | not admin / bearer | 401 / 403 (the guard) |
| `POST /autostart` | manager app / not installed / enabled null | 409 `AUTOSTART_UNAVAILABLE`, the three sentences in § 3.4 |
| `POST /autostart` | CLI non-zero | 500 with the CLI's `err` |
| `desktop_service(uninstall)` in app mode | — | `Err("no service is installed; this server runs with the app")` |
| `desktop_set_supervision` | any step non-zero | `Ok(ActionResult{ok:false, stdout: log, stderr})` — the chain's channel discipline; the setting is written only AFTER the step that makes it true succeeds (uninstall before `App`; stop before `Service`) |
| supervisor `stop()` | child ignores SIGTERM for 10 s | SIGKILL; `last_exit` records the signal |
| boot in app mode | not `Ready` after 5 s | recovery screen, "Your Server Is Stopped", Start idempotent, `error` names the last exit if any |

## 9. Tests

**`apps/server/api/src/__tests__/service.test.ts`** (extend; injected `runCmd`,
temp home, fake fs seams as the suite already does):
- linux: `enable`/`disable` argv is exactly `["systemctl","--user","enable"|"disable","subshell-server.service"]` and NOTHING ELSE runs (no `--now`, no stop/start).
- linux: `install --no-autostart` runs `daemon-reload` then `start`, never `enable`; success line as § 3.1; `queryService` then reports `enabled:false` from an injected `UnitFileState=disabled`.
- darwin: after `install` the plist exists at the LaunchAgents path and NOT the session path; after `install --no-autostart` the reverse; `queryService.enabled` follows the location; `definitionPath` names the existing one.
- darwin: `disable` writes the session path BEFORE removing the LaunchAgents path (assert the seam call order); a failing destination write leaves the source.
- darwin: `start` on a disabled service bootstraps from the SESSION path.
- darwin: `uninstall` removes whichever exists; both if both.
- `setAutostart` on nothing installed → exit 1 with the sentence.
- `installService` default `opts` is `{autostart:true}` and produces today's byte-exact unit/plist/argv (the existing pinned-text tests must not change).

**`apps/server/api/src/__tests__/cli.test.ts`**: `service enable`/`disable` dispatch; `service install --no-autostart` accepted; `service enable --json` refused as unexpected argument; `USAGE` lists the three new lines.

**`apps/server/api/src/api/admin-server/__tests__/autostart.route.test.ts`** (new; model on `restart.route.test.ts`'s seams): 200 with the view and `enabled` flipped; audit row `server.autostart.update` with `{from,to}` written once and NOT written on a no-op; 409 ×3 with the exact codes/sentences; 403 for a bearer key; 500 carrying the CLI's `err`.

**`apps/server/api/src/services/__tests__/server-deployment.test.ts`**: `appSupervised` true only when name AND ppid match; the app-mode view block exactly as § 4.7; `restart.available` true there; the conflict `detail` when a definition also exists.

**`apps/server/web/src/components/__tests__/service-card.test.tsx`**: switch checked/unchecked from `enabled`; the three disabled reasons; the supervision line for `manager:"app"`; the door button present only under the desktop marker and with the right label per mode; absent otherwise.

**`apps/server/web/src/hooks/__tests__/use-server-autostart.test.ts`** (new): POSTs `{enabled}`, writes the returned view into the query cache, surfaces an error and reverts.

**`e2e/tests/16-server-service.spec.ts`**: on the hand-started stack the "Start at login" switch is disabled and the reason "No service is installed on this machine." is visible; `POST /api/admin/server/autostart` over HTTP answers 409 `AUTOSTART_UNAVAILABLE` (the server refuses too, not only the UI — the existing restart test's shape).

**`apps/server/desktop/src-tauri`** (`cargo test`):
- `supervisor.rs`: over the injected spawner — `start` spawns once; a child exit while desired=Running respawns after exactly one `sleep(5 s)`; `stop` terminates the pid ONLY (assert the terminate seam received the pid, and that no group-signal API exists in the module), waits, and does not respawn; `restart` respawns without the sleep; `start` twice spawns once; `snapshot().last_exit` records the code.
- `control.rs`: `effective_supervision` (disk wins); `decide()` app-mode → `Ready` when listening else `Start`, and never `InstallService`; the app-mode `error` sentence when the last exit is recent and non-zero; `SetupStep` sequence for each of the four checkbox combinations (pure over an injected step runner — extend the pattern `desktop_setup` tests use).
- `reset.rs`: `parse_screen("supervision")`; reset step 6 writes `supervision = Service`.
- `settings.rs` (`desktop-core`): a file without `supervision` deserializes to `Service`; round-trips `"app"`.

**`apps/server/desktop/ui/src/__tests__`**:
- `wizard-state.test.ts`: `setupRows` for the three choices; the `service` row's `done` rules.
- `ipc-acl.test.ts`: passes with the one new command (it will fail until all three files agree — that is the test doing its job).
- a new `setup-choice.test.ts` for the pure part of the checkbox pair: unchecking background forces autostart false and disabled; re-checking restores true.

**Manual** (§ 12): the login behaviour on both platforms cannot be automated
and is written into the app's AGENTS.md checklist.

## 10. Documentation to update

- **`docs/security.md` § 11** "Not moved, deliberately": add
  *"The one service preference that IS reachable from the page is whether
  the service starts at login (`POST /api/admin/server/autostart`): it
  changes nothing about the running process, so it is inside the rule
  rather than an exception to it."* Add the § 4.7 trust accounting as a new
  short subsection **"The desktop app as supervisor"** (env var + parentage
  check + what a forged claim buys and why it is accepted).
- **`.claude/rules/security-context.md`**: mirror both in the "desktop apps"
  and "An admin reconfigures and restarts" passages (one sentence each).
- **`apps/server/desktop/AGENTS.md`**: new section **"Who runs the server"**
  (the setting, D5, the supervisor contract, main-pid-only, the console log
  path, `RunEvent::Exit`, the boot grace, the 5 s parity, orphans); the
  setup screen's two boxes in "The assistant"; `Screen::Supervision` in the
  screens list; the manual checklist below; the "Where things live" tree
  gains `supervisor.rs`; the IPC boundary section lists the new command.
- **`apps/server/api/AGENTS.md`** "Standalone binary & CLI": the two verbs
  and the flag; the darwin location rule with the two rejected alternatives
  (D2) — this is where a future maintainer will look before "simplifying" it
  back to `RunAtLoad`.
- **`apps/server/web/AGENTS.md`**: one paragraph under the Service page
  description: the switch, the three reasons, the door.
- **`README.md`** (~line 75–90, the setup paragraph): the two boxes in one
  sentence, and that unchecking the first makes the server live with the app.
- **`crates/desktop-core/src/settings.rs`**: the field doc (§ 4.1).

## 11. Changesets and versions

- `.changeset/server-autostart-and-supervision.md`:
  `"@internal/server": minor` — *"`subshell-server service enable|disable`
  and `service install --no-autostart` control whether the background service
  starts at login; the Service page gets a Start at login switch
  (`POST /api/admin/server/autostart`); a server the Subshell Server app runs
  now reports that, so Restart server works there too."*
  `"@internal/desktop-server": minor` — *"Setup asks two things it used to
  assume: whether the server runs in the background, and whether it starts
  at every login. With the first unchecked the app runs the server itself —
  alive while the app is open, stopped when you quit, running subshells kept.
  A new 'How Your Server Runs' screen, reachable from the dashboard's
  Service page, switches later."*
- **Never** a changeset for `@internal/server-web` (ignored package; it wedges
  the version PR — root AGENTS.md).
- **Version coupling**: the desktop app may be driving an OLDER installed
  `subshell-server` (the ladder adopts a newer installed copy; an older one
  is what `install_server_now` replaces). Add
  `MIN_AUTOSTART_SERVER_VERSION` in `control.rs` = the `@internal/server`
  version this ships in; when `probe.server.version` is below it, the login
  checkbox and the supervision screen's autostart box render disabled with
  *"Update your server to control this."* The bundled server is always new
  enough on a fresh setup, so the setup screen is unaffected in practice.
  App mode against an old server degrades honestly: the SPA shows "Running,
  not supervised" and Restart is disabled — nothing lies.

## 12. Verification

Before any commit, all of:

```bash
bun run lint && bun run lint:check
bun run verify-types
bun run test
bun run rust:check          # fmt + clippy -D warnings + tests, all three crates
bun run lint:licenses
cd e2e && bunx playwright test tests/01-setup-wizard.spec.ts tests/16-server-service.spec.ts
```

(`01` writes the shared `.auth/admin.json` that `16` needs; run them together.
Do NOT prefix with `timeout` — it re-execs itself in this environment.)

**Manual checklist** (add to `apps/server/desktop/AGENTS.md`; none of these
can be automated):

1. Fresh machine, both boxes checked → identical to today: service installed,
   `service status` says enabled, dashboard opens.
2. Box 2 unchecked → `service status` says not enabled; log out and in →
   the server is NOT running; `service start` brings it up (darwin: from the
   session path); the SPA switch turns it on; log out and in → running.
3. Box 1 unchecked → no plist/unit anywhere; SPA says "Running under
   Subshell Server as pid N · stops when the app quits"; **launch a subshell,
   quit the app, confirm the pane's tmux server survives** (`tmux -L
   subshell-<id> ls`); relaunch → server back within the boot grace, dashboard
   opens.
4. In app mode, SPA Restart server → 202, the server comes back in ~5 s, the
   waiter reports "back".
5. App mode with close-to-tray: close the window → server keeps running
   (tray-resident app); Quit from the tray → server stops.
6. The door both ways: Service→App (subshells survive the uninstall's stop
   when the definition is pane-safe), App→Service with each autostart value.
7. Reset in app mode → child stopped first, wipe, restart into first run.

## 13. Out of scope (named so nobody infers them)

- **The app starting at login** (`Settings.open_at_login`, reserved for
  Phase 4). Under app mode the login switch says "start the app at login
  instead" and does nothing; that feature lands separately.
- **Subshell Client / the node agent's service.** `subshell service` can
  grow the same `enable|disable|--no-autostart` shape later; the node
  Service surface (spec 2026-09-12 node half) would then expose it. Not here.
- **Adopting an orphaned server** the app did not spawn (§ 4.2).
- **A start limiter** for crash loops — parity with the unit is "always".

## 14. Suggested implementation order

Each phase is independently shippable and verifiable; the order minimizes
the time the tree is in a half-state:

- **A. CLI** — `setAutostart`, `install --no-autostart`, the darwin location
  rule, `queryService`/`uninstall`/`bootstrapDarwin` changes, `USAGE`, tests.
- **B. API + SPA switch** — `autostart.route.ts`, `AUTOSTART_UNAVAILABLE`,
  `serviceDeps()` extraction, schema/type unions, `use-server-autostart`,
  the switch + reasons, e2e assertions.
- **C. Desktop foundations** — `Supervision` setting, `supervisor.rs`,
  `effective_supervision`, `decide()` branch, `desktop_service` routing,
  `RunEvent::Exit`, boot grace, reset changes, `SUBSHELL_SUPERVISOR*` on
  the server side (§ 4.7), `Probe` fields + TS mirror.
- **D. Setup screen** — the two checkboxes, `desktop_setup` payload, rows.
- **E. Switching** — `desktop_set_supervision`, `Screen::Supervision`, the
  screen, the SPA door, the ACL triple.
- **F. Docs + changesets** — § 10, § 11; the manual checklist run once, its
  results recorded in the commit message.

Commit per phase; run the full § 12 set before each.

## 15. Measurements the implementer must make and record

Record each answer in a code comment at the point of use, with the macOS /
Linux version it was measured on:

1. **A `KeepAlive=true` job with `RunAtLoad=false` still launches at load.**
   Expected yes (this is what rules out the flag approach). If NO on the
   current macOS: the location rule (§ 3.2) is still the right design (it
   avoids the disabled-database footgun), but the comment should say the
   flag would have worked and why location was still chosen.
2. **A plist bootstrapped from outside `~/Library/LaunchAgents` is not loaded
   at the next login.** Expected yes; it is the premise of § 3.2. If no,
   stop and report — the design needs a new mechanism.
3. **SIGTERM to the server's main pid leaves its tmux servers running.**
   Expected yes (they are separate processes; nothing sends a group signal).
   Manual check 3 in § 12 is this.
4. **The server binds within `BOOT_START_GRACE`** on a cold start. Measure;
   if it routinely exceeds 5 s, raise the constant and say why.
5. **`process.ppid` under Bun on both platforms is the spawning app's pid**
   for a `std::process::Command` child (no intermediate shell). Expected yes.
