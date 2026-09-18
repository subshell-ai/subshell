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
| D6 | The name becomes true rather than being disambiguated: one act that updates both is honestly called *Update Subshell Server* | the "App" wording fix this spec supersedes — note §7.2's confirm fix is a different string and still lands |
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

**Fix, and it is DEFERRED** (decision taken 2026-09-18 while the operator was
away): each desktop `release.ts` already BUILDS that sidecar, so it could write
`bundledCli: "<version>"` into its manifest, and the screen would state both
numbers up front for every release cut after the change.

It is not in the first cut of this work, on the balance of what it costs
against what it buys:

- `release-manifest.json` is the **trust anchor** — it is minisign-signed and
  every product verifies it before trusting a byte. Adding a field means
  touching the strict parser that guards that door, for a release that is about
  to be cut.
- What it buys is one NUMBER, one phase early. The sentence is accurate either
  way.
- **The fallback runs regardless.** Manifests already published cannot gain the
  field, so the unnumbered sentence is the path every existing release takes no
  matter when this lands — which means shipping the field does not remove a
  code path, it adds a second one.

So phase 1 says "and the server it ships" without a number, the number appears
after the relaunch, and the manifest field is a follow-up to be taken on its
own merits rather than inside a release cut.

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
automatically: the screen offers **Retry** and says which versions were
involved and that the install did not finish — NOT why, since the failure text
is page state in a process that no longer exists and nothing persists it across
the relaunch (corrected in review, 2026-09-18; a `last_error` on the marker is
the follow-up that would make it literal). This is the one place the design
refuses to keep trying on the user's behalf.

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

  **This is a property of the ACT, not of the screen** — amended 2026-09-18
  after review, because the original wording described only phase 1 and that
  silence is the hole two defects fell through. Phase 2 runs in a different
  process, on a machine it re-reads; if it asks a different question it will
  reach a different answer, and the refusal a person was shown before the
  relaunch will simply not be honoured after it.

  Concretely, both halves must ask the SAME managed-aware question the offer
  asks — `Probe::decide()` deliberately compares the bundle against the
  bundle's own version on an unmanaged machine, so the offer reads "up to
  date" — and every call site that feeds `resume_decision` must use it. The
  first fix changed one of the two server call sites and left `boot_resume`
  reading the raw version: the destructive half was gone, but the marker
  became unclearable, so the assistant opened on every launch forever. That is
  the same "offer again forever" the comparison exists to prevent, arrived at
  from the other side.

  Two rules follow, and they are the reason this paragraph exists:
  - **Grep for the raw read after touching this.** `p.server.as_ref()...version`
    / `probe.agent.as_ref()...version` is correct in a few places and wrong in
    the resume path; each hit should be confirmed rather than assumed.
  - **A test for this must enter through `resume_view` or `boot_resume`**, not
    call `resume_decision` with the accessor already applied. Tests written the
    second way assert the fix's INTENT and pass while the real call site does
    something else — which is exactly how the half-fix survived.
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

The same act, the same marker, the same screen shape. Three things differ, and
only the first is inherited unchanged.

### 7.1 Phase 2 does not restart the daemon — it OFFERS to

`node_install_agent` passes `--no-restart`, and that stays: restarting a node
agent kills every subshell on the machine when the service definition does not
spare panes, which is why the CLI itself refuses without `--force`. Doing it
unasked would be performing the destructive act on someone's behalf.

**But not restarting is not the same as not saying so, and today the app does
not say so.** The only mention lives in the *pre*-install confirm, and after
the install succeeds nothing on screen mentions it at all. The machine is left
running the PREVIOUS agent — `rename(2)` leaves the running process on its
original inode — with nothing reporting the one state the person needs to know.

So phase 2 ends by offering it:

> The agent was replaced. The daemon is still running the previous version.
> **[ Restart the agent ]**

routed through the existing `commands.restart()`, which already surfaces the
CLI's verbatim refusal, offers `--force` behind it, and points at *Rewrite the
service definition* as the better fix. Nothing new decides any of that.

It needs no detection of the running daemon's version: *this window installed
an agent and did not restart it* is page state, exactly as `ranSetupHere` is on
the server side. A restart from any other surface, or a later launch, clears
it — the offer is about what just happened here, not a standing verdict.

### 7.2 Two stale sentences in the confirm, fixed

The pre-install confirm currently reads:

> "The service is stopped first so the file can be replaced, and is NOT started
> again. Start it from here afterwards."

Both halves are false:

- **"stopped first"** — `install_agent_now` passes a no-op closure where the
  stop callback used to be, and the managed path goes through the CLI's
  `update --from`, whose swap is a `rename(2)` a running daemon never notices.
  `apps/client/desktop/AGENTS.md` records the removal; this copy was not
  updated with it.
- **"Start it"** — it was never stopped. It is running, on the old binary. The
  verb is *restart*.

It becomes: "The agent that ships inside this app is installed over
`~/.local/bin/subshell`. Nothing is downloaded, and the running daemon is not
interrupted — it keeps running the previous version until you restart it."
The pane-safety line stays, attached to the RESTART where it belongs rather
than to an install that no longer stops anything.

**This fix stands alone.** It is a correction to a sentence that is wrong today
and should land whether or not the rest of this spec is built.

### 7.3 The agent is not otherwise touched by an app update

Replacing the app replaces the binary it bundles, which is a source to install
FROM and is on no rung of the resolution ladder. The running daemon keeps
running the installed copy until phase 2 lands, and the screen says so.

### 7.4 The status screen's own button

`NodeScreenId`'s `app-update` collapses into `update` exactly as the server
app's does — and the status screen's **"Update the agent to {version}"**
(`status-screen.tsx`) becomes a DOOR to that one screen rather than a
standalone agent-only install.

Without this, D1 is only half applied: Subshell Client would still have two
ways to update, one of which quietly does half the job. The button stays where
it is — the status screen is the natural place to notice the agent is behind —
but pressing it opens the one act, which then does whichever halves are
actually behind (§4.1's "CLI only behind" case covers an app that is already
current).

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

## 11. How this ships

Recorded here because the operator asked for it explicitly and will not be
available while it is built (2026-09-18): the decisions below were taken
without them, and this section is what they are accountable to on return.

1. **Implement to this spec**, in the order §12 gives.
2. **Full verification after every wave** — `bun run verify-types`,
   `bun run lint:check`, `bun run test`, and `bun run rust:check` for the Rust
   halves, plus `bun run lint:design` for anything that renders. A wave is not
   done while any of them is red.
3. **A full code review**, dispatched to a reviewer that did not write the
   code, over the whole range rather than per commit.
4. **Fix every Critical, Important AND Minor finding**, or record in the commit
   why a finding is declined. "No minor and major issues" is the bar, not
   "nothing critical" — a Minor that is genuinely wrong is still wrong.
5. **Re-review after the fixes**, because a fix wave is new code that nobody
   has read.
6. **Open a PR**, merge it once CI is green — plainly, after watching the
   checks; this repo has no auto-merge.
7. **Cut a release**: `bunx changeset` on the two desktop apps, merge the
   version PR, then `gh workflow run release.yml` for `desktop-server` and
   `desktop-client` **sequentially** — a second dispatch evicts the first while
   it is still queued. Verify each release carries `release-manifest.json` and
   its `.sig`, or an installed product will refuse it by name.

**Decisions taken without the operator**, listed so they are easy to reverse:

- §7.1's restart OFFER rather than an automatic restart, and rather than the
  silence it replaces.
- §7.4's status-screen button becoming a door rather than being deleted.
- §5's `attempts` bound of 2, and `forced` crossing the relaunch in the marker.
- The **C1/C2 fix**: one managed-aware accessor per app
  (`comparable_server_version` / `comparable_agent_version`), fed to every
  `resume_decision` call site, so the not-managed refusal survives the
  relaunch. Found in review; §6 now states it as a property of the act.
- **`last_error` on the marker: DEFERRED.** A halted screen therefore names
  versions and the failure, never the CLI's reason. Adding a field to the
  marker in the same change that fixed the marker's correctness, immediately
  before a release, buys one sentence at the cost of new surface on the
  structure this design rests on.
- §4.3's `bundledCli` manifest field, DEFERRED — it changes the signed
  trust anchor for one number shown one phase early, and the fallback it
  would need runs for every already-published release anyway.

## 12. Order of work

Each wave is independently verifiable and leaves the product working:

1. **§7.2 alone** — the stale confirm copy. It is wrong today, fixes nothing
   else, and depends on nothing here.
2. **`desktop-core`** — `PendingBundledInstall`, the `Settings` field, and the
   pure `resume_decision`, with its tests. Nothing reads it yet.
3. **Server app** — collapse the two screens to one, the two-phase act, the
   marker write and the boot resume.
4. **Client app** — the same, plus §7.1's restart offer and §7.4's door.
5. **The SPA** — D4's folded row behind `isServerDesktop()`.
6. ~~**`release.ts`** — `bundledCli` in both manifests~~ — DEFERRED, see §4.3.
   The screen's unnumbered fallback is what ships.
7. **Docs** — both apps' `AGENTS.md`, which carry the "two screens say update"
   section this spec deletes.

## 13. Amendment (2026-09-18): the act is a SELECTION, not always both halves

Operator's report, with the app at 0.8.1 and a `subshell-server` CLI updated
separately to 0.10.1: *"it says subshell-server is older than the currently
running version."*

**The defect.** When the app is behind, `updateAct` pushed the CLI row
unconditionally (bar the not-managed refusal) and the subtitle promised
"Installing it also installs the server it ships". But `serverChoice` was
`adopt-installed` — the ladder ADOPTS a newer installed copy — so phase 2
would answer `Resume::Clear` and install nothing. The screen named a version
older than the running one as a target, and promised an install that could not
happen. The act itself was never unsafe (`version_lt(installed, bundled)` is
false, so nothing downgrades); the DISPLAY was false, which is the defect class
§11 exists to keep out of a release.

**Why this is not a reversal of D1.** D1's argument was that being asked to
perform two updates for one thing makes our packaging the user's problem. That
holds exactly while the two halves point the same way. When they diverge — a
newer CLI installed by hand, an app behind — one act is not a simplification,
it is a claim about the machine that is wrong. A selection degenerates
correctly: with both halves behind, both are selected and one press does both,
which is D1 unchanged.

### 13.1 The table

Every component the screen knows about gets a row: what it runs, what it would
become, and a checkbox where there is something to do.

```
Component                Running   New      Update
Subshell Server app      0.8.1     0.9.0    [x]
subshell-server CLI      0.10.1    —        you run a newer one
```

- **A row with an available act carries a checkbox, selected by default.** The
  default IS the old behaviour: everything actionable, one press.
- **A row with no available act states WHY, in the cell where its checkbox
  would be** — never a disabled checkbox, which says "not now" without saying
  anything. The reasons are §6's, plus the new one below.
- The press names what it will do, and is dead when nothing is selected.

### 13.2 Force, and the one thing it may not do

One checkbox below the table: **override the pane-safety refusal** for the
selections above. That is the only refusal a person may overrule, and it is
already the one `--force` means everywhere else in this product.

**Force may NOT install an older bundled CLI over a newer installed one, and
this is a hard rule rather than a scope decision.** Root `AGENTS.md`: *"Never
downgrade the installed server. Boot runs `migrator.migrateToLatest()`, which
is forward-only… the reverse is data loss, not a choice to present."* An older
server cannot boot on a database a newer one has migrated, so a checkbox
offering it would be offering an unbootable machine. The row says so instead,
and the supported path — `subshell-server update --from <file>`, which takes
the database backup first — stays where it is.

### 13.3 Subshell Client

Identical shape, identical divergence (an agent installed by hand outranks the
bundle), with one difference that follows from §7.1: the agent half has no
restart to force, so Force applies to the server app's rows only and is not
rendered where nothing it governs is selectable.
