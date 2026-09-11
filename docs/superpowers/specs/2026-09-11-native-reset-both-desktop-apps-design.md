# Design: Reset from the native app, in both desktop apps

Date: 2026-09-11
Status: approved design (operator decisions taken 2026-09-11, recorded in § 2).
Extends `2026-09-10-desktop-first-run-wizard-and-reset-design.md` § 7, which
built the server app's reset and is otherwise unchanged by this document.

## 1. The problem

**Subshell Server's reset is reachable only through the server's own SPA.**
`reset::arm_and_raise` is called from `desktop_open_console`, which only the
dashboard's Settings danger card invokes, and the console's reset view is
entered ONLY by the `desktop-screen` event that call emits
(`ui/src/main.ts:1178`). So a reset requires a server that boots, a browser
session, and an admin role.

Every one of those can be the thing that is broken. A server that will not
start, a config.env with an address nothing answers on, a forgotten admin
password, an instance whose only admin account is gone: each leaves the
machine in a state the app was built to repair, with the repair behind the
thing that is broken. The console already exists for exactly this reason ("it
must render with the server DOWN"), and this one action is missing from it.

**Subshell Client has no reset at all.** A machine enrolled as a node holds a
node key, an identity keypair, per-subshell metadata and pane logs, and runs a
background service. Nothing in the app removes any of it. The only route is a
terminal: `subshell service uninstall`, then deleting two paths by hand, one
of which is only named inside the other.

## 2. Decisions taken

- **The server app's native entry is a collapsed "Danger zone" disclosure** at
  the bottom of the console's status view, not a button in the action row
  beside Restart and Stop. Discoverable without hunting; not one mis-click
  from two routine actions.
- **The client app's reset removes everything except the binary**: the
  service, this node's panes, `config.json`, the daemon lock, and the whole
  data directory — identity keypair, allowed-dirs, subshell metadata and pane
  logs included. `~/.local/bin/subshell` stays, matching the server app's
  reset, which keeps its own binary so the app can still manage the machine
  afterwards.
- **The SPA's danger card stays exactly as it is.** This adds a second door,
  it does not replace the first.

## 3. Why a console reset is not an escalation

Worth stating, because "make the destructive thing easier to reach" deserves
the argument written down.

The gate that disappears is the admin cookie. What remains is the OS user
account: whoever can click this button is already logged in as the user that
owns the data directory, the config file and the service, and can delete all
three with `rm -rf`. `apps/server/desktop`'s whole posture is that it "adds no
server surface — everything privileged goes through a CLI as the same local
user" (`docs/security.md` § 8b). A console button is that posture applied to
one more verb.

The gates that remain are the ones that were doing the work: the typed
hostname (`consent_granted`, fail-closed on an unreadable name), the
all-or-nothing delete plan read from the CLI's own report, and the containment
guard that refuses any recursive delete reaching the binary the reset promises
to keep.

What this does NOT do is widen the remote window. `capabilities/main.json`
still grants three commands, none of them these; the SPA still reaches reset
only by naming a SCREEN. Subshell Client's remote plane window is still
granted nothing at all.

## 4. Server app: a console-side entry

### 4.1 A new command, rather than re-granting an old one

The console cannot call `desktop_open_console` — that grant was deliberately
removed from `console.json` when the wizard arrived, because no console code
path invoked it. Re-adding it to arm a reset would be the wrong shape twice:
it means "show me the manage window", and the console IS the manage window.

So: **`desktop_arm_reset`**, granted to the console alone. It performs the
arming half of `arm_and_raise` and nothing else — a fresh
`control::probe_now`, `parse_delete_plan`, stash — and returns whether a plan
was armed. The page then switches to its own reset view with the `showReset()`
it already has.

Every property of the existing path is preserved by construction: the plan is
still stashed from a probe taken at press time (R18), the page still supplies
only a hostname, and `desktop_reset` is untouched.

```rust
/// Arm the reset screen from the console itself. The arming half of
/// `arm_and_raise`, without the window half: this window is already up.
#[tauri::command(async)]
pub fn desktop_arm_reset(app: AppHandle, settings: State<'_, SettingsState>) -> bool;
```

Returns `true` when a plan parsed. `false` means the screen will render its own
refusal — the page shows it either way, because the refusal is the useful
information ("the server would not report its paths, so there is nothing this
can safely delete").

### 4.2 The ACL

`permissions/desktop.toml` gains `allow-desktop-arm-reset`; `console.json`
gains it. **`wizard.json` and `main.json` do not.** `ipc-acl.test.ts` asserts
per-page exactness, so this is enforced rather than intended.

### 4.3 The UI

At the bottom of `#status-view`, after the pane region:

```html
<details class="danger-zone" id="danger-zone">
  <summary>Danger zone</summary>
  <p class="hint">
    Reset this machine's Subshell instance: stop the server, delete its
    database, logs and settings, and return to setup. The installed server
    binary stays.
  </p>
  <button type="button" id="reset-open">Reset this machine…</button>
</details>
```

`#reset-open` calls `ipc.armReset()` then `showReset()`. The disclosure is
closed on every render — a destructive section that remembers being open is a
destructive section someone scrolls past without reading.

Styling: `.danger-zone > summary` in `--color-muted`, its button bordered in
`--color-bad`. No colour change to the existing `.primary`.

## 5. Client app: reset at all

### 5.1 The node CLI must report its own paths

The server's reset takes its deletion set from `subshell-server status --json`'s
`paths` block, and the reason is recorded as R17/R18: a reset that deleted what
the Rust side GUESSED rather than what the CLI NAMED would be the R1 failure
with a typed hostname in front of it. The node CLI has no such block —
`status --json` reports `nodeId`, `serverUrl`, `online`, `agentVersion` and two
optional fields.

`apps/node/agent/src/cli.ts`'s `status` gains:

```jsonc
"paths": {
  "configFile": "/Users/you/.config/subshell/config.json",
  "lockFile":   "/Users/you/.config/subshell/daemon.lock",
  "dataDir":    "/Users/you/.config/subshell/data"
}
```

Three rules:

- **Only in the enrolled case.** `dataDir` is stored INSIDE `config.json`, so
  a machine with no config has no data directory to name. The not-enrolled
  branch (the `missing` object) carries no `paths`, and the reset screen then
  refuses with "this machine is not enrolled as a node, so there is nothing to
  reset" — which is the truth, and is not a failure.
- **Present even when OFFLINE.** `status` exits 1 when no daemon is running;
  the paths are a property of the configuration, not of liveness, and an
  offline node is the commonest thing to want to reset.
- **Never the node key.** `status` already refuses to echo it "not even via
  `--json`"; adding paths does not change that.

### 5.2 The deletion set, and its order

| # | Step | Why |
|---|---|---|
| 1 | `subshell service stop` | The daemon holds the lock and may be mid-command. |
| 2 | Kill this product's tmux servers | Panes launched here outlive the agent otherwise, holding subshell bearer tokens (`docs/security.md` § 6). Same socket rule as the server app: `TMUX_TMPDIR ?? /tmp`, symlink-resolved, `tmux-<uid>/`, and only `subshell-*`. |
| 3 | `subshell service uninstall` | Remove the unit/plist so nothing restarts it. |
| 4 | Delete `dataDir` | Identity keypair, allowed-dirs, subshell metadata, pane logs. |
| 5 | Delete `lockFile` | A stale lock outliving its config would make `status` read another node's. |
| 6 | Delete `configFile` | **Last, and this is load-bearing.** It is the only thing that names `dataDir`. Deleted first, a chain that died at step 4 would leave a data directory nothing can find — the same retry-inversion the server's config.env-last rule exists for (R4). |
| 7 | Clear this app's own settings | `binary_path`, the tray preference. |

No window dance. The server app closes `main`, opens the wizard and closes the
console last because it has one manage window and a zero-window moment quits
the app. Subshell Client's two windows are a remote plane window and the
bundled node page; resetting the node invalidates neither — the plane is
another machine's server and the user's session there is untouched. The node
page's own 1500 ms probe reports "not enrolled" on the next tick, which is the
honest end state.

### 5.3 The guards

Identical in force to the server's, and § 6 makes them literally the same code:

- **Typed hostname**, compared against the one memoized `hostname(1)` read the
  screen was rendered from. An unreadable name refuses rather than arming on
  an empty box.
- **All-or-nothing plan**: all three paths present, non-empty and absolute, or
  there is no plan.
- **Shape rules** on every target: absolute, never `/`, never `$HOME` itself.
- **Containment**: no recursive delete may be, or contain, the installed
  `~/.local/bin/subshell` this reset promises to keep. Both sides canonicalized
  before the prefix test (P3) — a symlinked spelling passes a naive test while
  the delete still reaches the binary.

### 5.4 The disclosures

The confirmation screen must say what a reset does NOT reach, because each is
something a user would reasonably assume it handles:

> - The control plane keeps a node row for this machine. It will show as
>   permanently offline, and its owner has to delete it there.
> - Any subshells that ran here are gone, and so are their pane logs.
> - A Subshell Server on this same machine is not touched. Reset it from its
>   own app.
> - The installed `subshell` binary stays.
> - Everything above is permanent.

### 5.5 Entry point and ACL

Same shape as § 4: a collapsed "Danger zone" on the node page, a
`node_arm_reset` command and a `node_reset` command, both granted to the
**bundled node page only**. The remote plane window's capability file names
neither — it names nothing, and that is the property to preserve: an XSS in a
control plane's SPA must still reach nothing in Subshell Client.

## 6. The guards move to `crates/desktop-core`

Both resets need `path_rules_ok`, `delete_guard_ok`, `is_subshell_socket` and
`consent_granted`. These are pure, `tauri`-free, and already exist in
`apps/server/desktop/src-tauri/src/reset.rs`.

`crates/desktop-core` is where this repo puts exactly that: "Everything that is
NOT `tauri`-typed lives outside the app." So they move to
`crates/desktop-core/src/reset_guards.rs`, with their tests, and both apps
import them.

This is the one refactor of shipped, reviewed code in this design, and it is
worth it for a reason specific to what these functions are: two copies of a
containment guard that drift is a machine that deletes a binary it promised to
keep. One copy cannot drift.

What does NOT move: `DeletePlan` and `parse_delete_plan` (different shapes —
five paths against three), the chains, the stashes, and the Tauri commands.
Each app keeps its own.

The `include_str!` containment test that pins `subshell-` between Rust and
`pane-runtime`'s `tmuxSocketFor` moves with `is_subshell_socket`, and must
keep pointing at the TypeScript file it pins.

## 7. Contracts

### 7.1 Rust, server app

```rust
pub fn desktop_arm_reset(app: AppHandle, settings: State<'_, SettingsState>) -> bool;
```

### 7.2 Rust, client app (`apps/client/desktop/src-tauri/src/reset.rs`, new)

```rust
pub struct DeletePlan { pub config_file: PathBuf, pub lock_file: PathBuf, pub data_dir: PathBuf }
pub fn parse_delete_plan(status: &Value) -> Option<DeletePlan>;
pub struct Stash { pub plan: Mutex<Option<DeletePlan>> }
pub fn node_arm_reset(app: AppHandle, settings: State<'_, SettingsState>) -> bool;
pub fn node_reset(app: AppHandle, typed: String) -> Result<ActionResult, String>;
```

`ActionResult` channel discipline is inherited: `Err` only for refusals before
the first mutation; a half-run is `Ok(ActionResult { ok: false, … })` carrying
every word the CLI said, plan still stashed so Retry converges.

### 7.3 `crates/desktop-core/src/reset_guards.rs` (new)

```rust
pub fn path_rules_ok(p: &Path, home: &Path) -> bool;
pub fn delete_guard_ok(dir: &Path, keep: &Path) -> bool;
pub fn is_subshell_socket(name: &str) -> bool;
pub fn consent_granted(typed: &str, memo: &str) -> bool;
```

### 7.4 Node CLI

`subshell status --json` gains `paths: { configFile, lockFile, dataDir }`,
present only when a config loaded.

## 8. Testing

- **desktop-core:** the moved guard tests, unchanged in substance, plus the
  `include_str!` pin re-pointed.
- **Server app:** `ipc-acl.test.ts` re-pins the console's set with
  `desktop_arm_reset` and asserts the wizard and `main` did not gain it. A Rust
  test that `desktop_arm_reset` stashes nothing when `status --json` will not
  parse, and that a plan parses when it does.
- **Client app:** `parse_delete_plan` all-or-nothing (each of the three fields
  missing in turn, a relative path, an empty string); `consent_granted` via the
  shared crate; a chain-order test asserting `configFile` is deleted last; the
  containment guard refusing a `dataDir` that contains the installed binary. An
  `ipc-acl`-equivalent asserting the plane window holds nothing.
- **Node CLI:** `status --json` carries `paths` when enrolled and omits it when
  not; the three paths are absolute; the node key appears in neither branch.
- **By hand**, because no automated test covers a real wipe: enrol a throwaway
  node, run the reset, confirm `~/.config/subshell` is gone, the service is
  absent from `systemctl --user` / `launchctl list`, no `subshell-*` tmux
  socket survives, `~/.local/bin/subshell` is still there, and the node page
  says not enrolled.

## 9. Docs

- `apps/server/desktop/AGENTS.md`: the reset section gains the console entry
  and the new command's grant.
- `apps/client/desktop/AGENTS.md`: a new reset section.
- `apps/node/agent/AGENTS.md`: the `paths` block in `status --json`.
- `docs/security.md`: § 8b gains the console entry's accounting (§ 3 above),
  and a short subsection for the client reset naming what it deletes and the
  orphaned node row it leaves.
- `.claude/rules/security-context.md`: one paragraph, pointing at both.
- `README.md`: the reset paragraph currently describes the SPA route only.
- Changesets: `@internal/desktop-server`, `@internal/desktop-client`,
  `@internal/node`. All three are releasable; none is on the ignore list.

## 10. Non-goals

- **Un-enrolling from the control plane.** A client reset cannot delete its own
  node row: the plane may be unreachable, and the call would need a credential
  the reset is in the middle of destroying. The row is disclosed, not chased.
- **Resetting a remote node from the server app.** That would need a signed
  command and a node verb, and it is a different feature: destroying someone
  else's machine's state from here.
- **A reset that also removes the installed binary.** Rejected in § 2: the app
  must still be able to manage the machine afterwards.
- **Any change to the SPA danger card**, to `main`'s three commands, or to the
  client plane window's zero commands.
