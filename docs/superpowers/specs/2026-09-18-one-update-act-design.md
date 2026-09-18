# One update act — design (2026-09-18)

## 1. Problem

On a machine running **Subshell Server**, a person is asked to perform three
different updates, by three different controls, for what they experience as one
thing:

| control | what it replaces | where it lives |
|---|---|---|
| *Update Subshell Server* (`app-update`) | the `.app` / `.deb`, then relaunches | assistant, reached from the tray and the SPA's app row |
| *Update Your Server* (`update`) | `~/.local/bin/subshell-server`, from the app's own **bundled** sidecar | assistant, reached from the SPA's Server row |
| *Update to X* | `~/.local/bin/subshell-server`, downloaded from the **release source** | the SPA's Server row |

Two of those install the same file from different places, and the first
**contains** the second: each desktop bundle ships the CLI it wraps
(root `AGENTS.md`, "a desktop cut re-releases that CLI"), and
`desktop_install_server` installs precisely that sidecar. So on a desktop
machine "update the app" and "update the server" are not independent acts —
the second is the tail of the first, and asking a person to run them separately
makes our packaging their problem.

It also produces a loop that reads as a bug: update the app, and the next boot's
probe sees a bundled server newer than the installed one and asks again.

**And the names cannot be told apart.** *Update Your Server* and *Update
Subshell Server* differ by a possessive, for two different acts; the tray says
"Update available — Subshell Server 0.8.1" for the app; only the SPA's row
name, "Subshell Server **app**", says which is which. Reported by the operator
on 2026-09-18: "it should be clear that we're updating the Subshell Server *App*
not subshell server itself".

**Subshell Client has the same shape** for the same reason — it bundles the node
agent — with its own pair: *Update Subshell Client* (the app) beside the status
screen's *Update the agent to X*.

## 2. Decisions

| # | decision | what it replaces |
|---|---|---|
| D1 | **One update act per app.** The assistant updates the application AND installs the CLI that application bundles, from one press | two screens, two presses, two names |
| D2 | The act is **two phases across the relaunch**, continued by a marker in `settings.json` that the NEW build finishes at boot | a second press the person had to know to make |
| D3 | The two assistant screens **collapse to one** — `Screen::Update` and `Screen::AppUpdate` become `update`; the old id is deleted, not aliased | the closed enum's two members |
| D4 | In the SPA, a desktop shell folds the app row and the Server row into **one row** whose only control opens the assistant | two rows offering two different updates of one product |
| D5 | A **browser or headless instance is untouched** and keeps the release-source server update — it has no assistant to open | — |
| D6 | The name becomes true rather than being disambiguated: one act that updates both is honestly called *Update Subshell Server* | the "App" wording fix this spec supersedes |
| D7 | Both apps, one spec, with the marker and the resume decision **shared in `crates/desktop-core`** | two implementations of one transaction |

## 3. Non-goals

- **No automatic update.** Detection stays automatic, application stays one
  deliberate press — spec 2026-09-15 §14 and its "we should never force an
  update on a user" stand unchanged. D2 automates the *second half of an act
  already consented to*, never the act.
- **No new Tauri command, and no widening of either remote window.** Both
  halves already exist as `wizard`/`node`-only commands; this changes when they
  run, not who may run them.
- **No change to the CLI's own `update`**, its transaction, its backup or its
  revert. The desktop path keeps delegating to it.
- **No change to the release-source server update** (`POST /api/admin/server/update`)
  or to node updates.

## 4. D1/D2: the act, and the two phases

### 4.1 What the screen shows

```
Update Subshell Server

  App        0.8.0 → 0.8.1
  Server     0.9.0 → 0.10.0   (ships with 0.8.1)

  [ Download and Install ]
```

Both rows are facts the screen can state; either may be absent:

- **App only behind** — ordinary case after a desktop cut.
- **Server only behind** — the app is current but its bundled server is newer
  than the installed one (a machine set up before the last app update, or one
  whose server install failed). One phase, no relaunch.
- **Neither** — "Subshell Server is up to date", no button.

### 4.2 The phases

1. Confirm (§6).
2. Download the app bundle, verify its signature against the pubkey compiled
   into this build, install it — all existing `tauri-plugin-updater` work.
3. **Write the marker** (§5) before the relaunch, never after: a crash between
   the two must leave a machine that knows what it was doing.
4. Relaunch.
5. The new build boots, reads the marker, opens the assistant at `update` in
   its *finishing* state, installs the bundled CLI, and — server app only —
   restarts the service.
6. Clear the marker. The screen says what was installed.

**The order is forced, not chosen.** The new app carries a newer bundled CLI,
so installing the CLI first installs the outgoing bundle's copy and leaves the
machine behind again the moment the app lands.

### 4.3 What the screen cannot say yet, and the fix

Before downloading, the app **cannot know which CLI version the new app
bundles**. A desktop `release-manifest.json` carries the component id, the
version, `NODE_PROTOCOL_VERSION`, `MIN_AGENT_VERSION`, the commit sha and the
`assets` digests — not the bundled CLI's version. So phase 1 says "and the
server it ships" without a number, and the number appears after the relaunch.

**Fix, in this spec:** each desktop `release.ts` already BUILDS that sidecar, so
it writes `bundledCli: "<version>"` into its manifest. The screen then states
both numbers up front for every release cut after the change, and falls back to
the unnumbered sentence for older ones — which it must anyway, since manifests
already published cannot gain the field.

## 5. D7: the marker, shared

`Settings` (`crates/desktop-core/src/settings.rs`) is already shared by both
apps and already carries `last_update_check_at` / `last_update_version`. It
gains one field:

```rust
/// An app update has landed and its bundled CLI has not been installed yet.
pub pending_bundled_install: Option<PendingBundledInstall>,

pub struct PendingBundledInstall {
    /// The app version that was running when the update was pressed.
    pub from_app_version: String,
    /// ISO 8601, for the audit line and for a human reading the file.
    pub started_at: String,
    /// How many boots have tried and failed. Bounded — see below.
    pub attempts: u32,
    /// The pane-safety override the person accepted in phase 1, if they did.
    pub forced: bool,
}
```

**`forced` is why the consent is not asked twice.** The pane-safety confirm
happens in phase 1, before the relaunch — and the act it consents to (a service
restart that may close live subshells) happens in phase 2, in a different
process. Re-asking after the relaunch would be asking again for something
already granted, on a screen the person did not choose to open; carrying the
answer in the marker is what makes one press mean one act. It is a persisted
destructive consent, so it is narrow by construction: one boolean, about one
restart, cleared with the marker, and worth nothing to anyone who edits it in
(the file's owner can already stop the service).

**No `kind` field.** Each app keys its own `settings.json` by its own bundle
identifier, so the subject is implied by which app is reading: the server app's
marker means the bundled server, the client's means the bundled agent.

**The marker converts an offer into a continuation**, and that is all it does.
Whether there is anything to install is still decided by the probe — the
bundled version against the installed one, the same comparison `decide_server`
already makes. So a marker whose work turns out to be done (a hand `subshell-server update`
in between, say) is **cleared without acting**, and no timestamp validity rule
is needed.

**`attempts` is bounded at 2.** A bundled install that fails on every boot would
otherwise re-run forever, taking the window to a failure screen each time the
person opens the app. At the limit the marker stays but stops firing
automatically: the screen offers **Retry** and says what failed. This is the one
place the design refuses to keep trying on the user's behalf.

What is shared in `desktop-core`, and what is not:

- **Shared:** the field, the struct, and `resume_decision(marker, bundled, installed, attempts) -> Resume::{Install, Clear, Halt}` — pure, and the whole of the branching.
- **Not shared:** what each app DOES with `Resume::Install`. The server app
  installs and restarts the service; the client app installs and does not
  restart the daemon (§7). That difference is real, and per the crate's own
  rule — "an abstraction over one real consumer and one guess is worse than the
  duplication" — it stays in each app's `control.rs`.
- **Mirrored, not shared:** the screens. One is vanilla DOM, one is React, and
  they are already deliberate copies (as the tmux screens are); a diff between
  them is the drift signal.

## 6. Refusals

Each fires before anything is written, and each says what it did instead of
what it refused.

- **Not managed.** `probe.managed` is false — the service definition names a
  binary somewhere other than `~/.local/bin/<cli>`. The app half runs; the CLI
  half does **not**, and the screen names the path the service actually runs.
  Writing a binary the service does not invoke is an update that reports
  success and changes nothing (root `AGENTS.md`, "never write the installed
  binary by convention").
- **Pane safety.** The server restart closes every live subshell on a
  definition that does not spare them. The existing confirm carries into the
  combined act unchanged — it is not skippable because it is now step 2 of 2 —
  and `--force` is passed only where the definition would refuse and the person
  accepted — carried across the relaunch in the marker's `forced`, never
  re-asked.

  **Phase 2 restarts by the path `renderUpdate` uses today**, which already
  branches on how this machine is supervised: a service manager restarts the
  unit, and an app-supervised server is the app's own child. Nothing new
  decides that here.
- **Air-gapped.** `SUBSHELL_RELEASE_URL` empty: there is no app update to
  fetch, and the screen says so by name. The bundled-CLI half is entirely
  local, so the screen still has a job.
- **An update already in flight.** `ActionGuard`, as every other chain here.

## 7. Subshell Client

The same act, the same marker, the same screen shape, with two differences that
are the app's own and predate this spec:

- **Phase 2 installs the bundled agent and does NOT restart the daemon.**
  `node_install_agent` passes `--no-restart` deliberately; the screen tells the
  person to start it. Keeping that rule is why `Resume::Install` is not shared.
- **The agent is not otherwise touched by an app update**: replacing the app
  replaces the binary it bundles, which is a source to install FROM and is on
  no rung of the resolution ladder. The running daemon keeps running the
  installed copy until phase 2 lands. The screen says so.

`NodeScreenId`'s `app-update` collapses into `update` exactly as the server
app's does.

## 8. D3/D4: the surfaces

**The assistant.** One screen id, `update`. Every door — the tray item, the
SPA's row, the sidebar pill — names it. `screenForRequest` and the closed Rust
enum lose `app-update`; nothing aliases it, because this product has no
installed base to keep compatible.

**The SPA, in a desktop shell** (`isServerDesktop()`): the Subshell Server app
row and the Server row become ONE row — name "Subshell Server", both version
pairs visible, one control, **Open the update assistant**. The bundled-server
sentence (`bundledServerUpdate`) is absorbed by that row, since the assistant
now handles exactly what it was announcing.

**The SPA, in a browser** (D5): unchanged. The Server row keeps its
release-source **Update to X** and its Re-check, the app rows keep their release
links, because nothing on that page can raise a window on a machine it is not
running on.

**Subshell Client's plane window** is granted one command and gains nothing
here; its update stays reached from the tray.

## 9. Testing

Pure, and therefore the bulk of it:

- `resume_decision` — install, clear-without-acting, halt at the attempt limit,
  and a marker on a machine whose bundled copy is not newer.
- The screen's plan: which rows render, which phases run, and the sentence for
  each refusal in §6 — one per app, in each app's own `lib/`.
- `PendingBundledInstall` round-trips through `settings.json`, and an unknown
  field in an older file does not fail the read.
- `release.ts`: the manifest carries `bundledCli`, and the screen falls back to
  the unnumbered sentence when it is absent.

Not testable from a checkout, and named here so it is checked by hand once: the
relaunch itself, and that a marker written before it is read by the new build.

## 10. Failure handling

A failure in phase 1 is an ordinary refused action — nothing was written, the
marker was never set.

A failure in phase 2 leaves the marker set and the machine in a state that is
honest rather than broken: the app is new, the CLI is the old one, and the
service is running the old one, which is a configuration that works. The screen
says exactly that, offers Retry, and after two automatic attempts stops trying
on its own. This is the whole reason the marker records `from_app_version` — a
person reading `settings.json` on a machine that will not finish can see which
update it was.
