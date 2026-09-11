# Design: The first-run wizard, and resetting a machine entirely

Date: 2026-09-10
Status: approved design (brainstorm 2026-09-10); this document revises
`2026-09-10-onboarding-to-first-subshell-design.md` §2/§5 as recorded in § 2
below, and changes nothing else that spec decided.

## Review disposition (2026-09-10)

Twelve findings landed the same day the draft was written (R1-R12, full text
in git history at `bb52f43`); all are addressed in the body, none disputed
the shape. Where each landed:

- **R1** (wrong temp-dir variable, silent-success on every Mac): § 7.2 step 3
  rewritten to `$TMUX_TMPDIR ?? /tmp` with symlink resolution, fail-the-chain
  semantics for a live kill failure, and the `cleanSocket` twin fixed in the
  same pass (§ 9, § 11).
- **R2** (Done's secondary button had no grant): § 3's wizard set now includes
  `allow-desktop-open-console`, with the note on why the console itself stays
  refused it.
- **R3** (shape guards could delete the promised-to-keep binary): § 7.2
  step 5 gained the containment layer (`delete_guard`) and § 11 its test.
- **R4** (config.env deletion order is load-bearing): step 5 restated as an
  order rule with the retry-inversion reason, config.env last, plus § 11's
  order test.
- **R5** (flag write durability): § 4 now states the mutex already prevents
  field loss, and that `Settings::save` moves to temp-plus-rename because
  one `fs::write` was not safe against truncation.
- **R6** (boot ordering ambiguity): § 3 now says boot probes first and
  branches on the fresh probe via a pure `boot_window`; § 11 gained the
  ready-at-boot fixture.
- **R7** (a local node agent survives the "virgin machine" claim): § 7.1's
  disclosure list grew to three, and § 13 records it as a non-goal.
- **R8** (asserted Tauri behaviour): measured against tauri 2.11.5's
  `ipc/command.rs` and quoted in § 6 (`v.get(self.key)` per declared
  argument; `deserialize_option` answers missing with `visit_none`).
- **R9** (hostname form): § 7.1 pins the exact-`hostname`-output form and
  records that `libc::gethostname` was considered and declined, with the
  check: libc is not a direct dependency of either crate.
- **R10** (licence argument rested on the wrong premise): § 8 now rests it on
  `AGPL_PREFIX` covering `apps/server/desktop`, and keeps the refuted
  premise visible as a parenthetical.
- **R11** (no tests for R3/R4/R6): § 11 gained all three, named per finding.
- **R12** (no exit from a gated Prerequisites step): § 5 step 2 states that
  the gate stops forward motion only; close, quit, and menu stay live.

## Review notes, round 2 (2026-09-10), to address before implementation

R1 through R12 are properly addressed; the measured Tauri behaviour in § 6, the
`cleanSocket` twin fix, and the `Settings::save` durability finding are all
better than what was asked for. I verified the four factual claims the
disposition makes and they hold: `main` really does carry
`allow-desktop-open-console` (`capabilities/main.json`), `libc` really is not a
direct dependency of either crate, `tmuxSocketPath`'s rule is as quoted, and
`apps/server/desktop` really is inside `AGPL_PREFIX`.

Five new findings, two of them blocking. **Both blockers are consequences of
the R3 and R4 fixes**, which is the ordinary hazard of a containment guard: it
protects a promise, and promises interact with defaults.

### Blocking

**R13. The containment guard refuses every default install, so reset would be
impossible on exactly the machines this design targets.** § 7.2 step 5 refuses
a directory that "contains, or equals, the resolved server binary path **or the
directory holding `config.env`**". On a default install those are the same
directory as the data dir:

- `configure.ts:423` writes `DATABASE_PATH` defaulting to
  `join(deps.configDir, "subshell.db")`, and `configDir` is by definition where
  `config.env` lives (`configure.ts:17,310`).
- `defaultSubshellServerDataDir` (`packages/subshell-protocol/src/paths.ts:325-329`)
  derives the data dir by stripping the filename off `DATABASE_PATH`.
- `config-env.ts:28` puts `configDir` at `~/.config/subshell-server`.

So `dataDir` **equals** the directory holding `config.env` on every machine the
desktop app sets up, the guard fires, and the chain refuses before touching
anything.

The fix is to drop `config.env`'s directory from the keep set entirely. It was
never something reset promises to keep: step 5 deletes `config.env` on purpose,
and § 7.1 lists it in the blast radius. The only thing the screen promises to
keep is the installed server binary, so that is the only path the containment
check needs. Keep the check, narrow it to one comparison, and say in the text
that `config.env`'s own directory is deliberately not protected because it is a
deletion target.

**R14. "config.env last" cannot hold in the default layout, because
`config.env` lives inside the directory that gets recursively deleted.** Same
three facts as R13. Step 5's order is database, logs, node-artifacts, data
directory recursively, then `config.env`. On a default install the recursive
delete of `~/.config/subshell-server` **takes `config.env` with it**, so by the
time the chain reaches its final step the file is already gone and R4's
ordering rule has been silently inverted on the common machine rather than the
exotic one.

That matters exactly where R4 said it does. If the recursive delete partially
fails (one locked file, one permission), the chain stops with `config.env`
already destroyed. A Retry then runs step 1 against a machine with no config,
`DATABASE_PATH` falls back to `DEFAULT_DATABASE_PATH` (`"./data/subshell.db"`,
`paths.ts:308`), the data dir resolves to a relative `./data`, and the shape
guard refuses it for not being absolute. The user is left with a half-deleted
instance and a Retry that can never converge, which is the precise failure R4
was written to prevent.

Two ways out, and the spec should pick one and say why:

- **Exclude `config.env` from the recursive delete**, then delete it, then
  remove the now-empty directory. Keeps the ordering rule literally true in
  both layouts, and costs one filter.
- **Capture the plan once and reuse it across retries.** Step 1 already reads
  `status --json`; hold the resolved path set for the life of the reset screen
  and have Retry re-run the captured plan rather than re-deriving it from a
  machine that may no longer be able to answer. Strictly more robust, and it
  also covers a retry after the database is gone.

The first is smaller. The second is the one that makes "retry converges" true
rather than nearly true, and the nesting in R13 is a good argument that
re-deriving from a half-deleted machine is not a safe primitive.

### Settle in the text

**R15. The hostname memoization and the Rust re-read can now disagree, and the
refusal is silent when they do.** § 7.1 memoizes the probe's hostname behind a
`OnceLock` ("a running machine does not rename itself") while `desktop_reset`
"re-reads the hostname itself and refuses unless the typed argument equals it".
A user who renames their machine while the app is running (System Settings on
macOS, `hostnamectl` on Linux) then sees the stale name on screen, types it
exactly as instructed, and gets a refusal that names no cause. The
double-check is right and should stay; what needs deciding is which value is
authoritative. Either both sides read the same memoized value, or the refusal
message says the machine's name changed since the screen was drawn and to
reopen it. Silent disagreement between a displayed value and a checked value
is the one outcome to rule out.

**R16. The marking rule is now in two places, which is what § 4 says it is
deliberately not.** § 4: "Marking rule, deliberately in one place:
`desktop_probe` sets the flag the first time it computes `next == Ready`" and
"the write lives in the command wrapper". § 3's R6 fix then has boot call
`probe_now` "(with the § 4 marking on its result)", which is a second site.
Nothing is wrong with the behaviour; the claim about it has just stopped being
true. Extract `mark_onboarded(&Probe, &SettingsState)`, have the command
wrapper and boot both call it, and let § 4's "one place" go on meaning one
function rather than one caller.

**R17. § 8 does not say whether a partial `paths` block is a refusal.** § 7.1
refuses a server that "does not report its data paths", which covers an absent
block. It does not cover a block that is present with a field missing, empty,
or relative. As written, § 7.2 step 5's "only paths the `paths` block reported"
would then delete a subset and report a successful reset, which is the same
class of quiet under-delete as R1. State that the block is all-or-nothing: four
absolute paths or the same refusal as no block at all.

## 1. The problem

The Subshell Server desktop app's first-run surface is the console: one page
that shows everything at once (status chip, a facts grid, one "next step" card,
the tray preference, and the log panes) and, on a fresh machine, asks the user
to press one button whose disclosure is a hint sentence. The verdict from the
product's owner: that is a status page, and a first-time user does not want a
status page. They want to be walked through setup step by step.

Second ask, arrived at during the same brainstorm: an admin must be able to
**reset the machine entirely** from the Settings area, behind a typed
confirmation (type the hostname, GitHub-style). Reset is what makes the
first-run flow worth extracting: it is the second way to arrive there, and a
guided window that can be re-entered cleanly beats a render mode buried in a
status page.

What already exists and shapes everything below:

- `probe.next` is a derived state machine (`no-server | setup | unreachable |
  init | install-service | start | ready`) computed from real facts in
  `desktop_probe` (`src-tauri/src/control.rs`).
- `desktop_setup` runs the whole fresh-machine chain (install bundled server →
  `init --yes` with derived defaults → service install → start), stops at the
  first failure, and is idempotent on a half-run (install reports
  "already installed", `init --yes` keeps stored values, start answers
  "already running").
- Every individual act is already a command: `desktop_init`, `desktop_service`,
  `desktop_install_server`, `desktop_install_tmux`, `desktop_install_agent`
  (all five harnesses are in `AGENT_INSTALLS`, both languages, mirror-pinned),
  `desktop_set_server_bin`, `desktop_open_main`.
- The SPA's own three-step wizard (Account → Agent → Launch) exists in
  `apps/server/web/src/routes/setup.tsx` and runs after the server is up.
  This design ends the desktop flow exactly where that one begins.
- The `terminal` built-in makes "no agent installed" a working state, so the
  wizard's agent step can be honest about being optional.

## 2. Decided constraints

Each of these was asked and answered during the brainstorm; they are the
design's contract with itself.

| question | decision |
| --- | --- |
| When does the wizard show? | Until setup has succeeded once. A persisted flag ends it; after that the status page is the permanent landing view. |
| Step shape? | Decisions are steps, machine work is progress. Steps: Welcome, Prerequisites, Addresses, Agents, Run (one consented press with a live checklist), Done. |
| Where does the status/settings page live? | Where it lives today: this app's window, reached from the dashboard's "Manage server" pill. |
| What does reset wipe? | Back to virgin machine: service, config, the whole data directory, this app's choices. The installed server binary stays. |
| Where is the reset entry? | The dashboard's Settings page; the confirmation and execution happen in this app's console window. |

Relationship to the onboarding spec of the same date: that spec's console
decision ("the console stops being a setup flow and becomes a one-click
installer plus a repair panel") is revised. The one-press chain survives, but
it moves inside the wizard's Run step, where the steps around it make the
disclosure visible instead of packing it into one hint line. The SPA half
(§§ 3–8 of that spec) stands untouched and remains the handoff target.

## 3. Three windows, and their lifecycle

The app gains a third bundled window. Each window keeps exactly one job, and
the ACL split is unchanged in kind: privileged verbs live only on bundled
pages, `main` holds exactly what it holds today.

| window | page | grants |
| --- | --- | --- |
| `wizard` | bundled `wizard.html` (new Vite input beside `index.html`) | the commands its page invokes: probe, setup, install-tmux, install-agent, set-server-bin, open-tmux-docs, open-main, open-console (the Done step's "Go to status page" is what calls it; the permission exists today and is granted to `main`; `console` is still refused it, which stays true now that a real caller exists), `dialog:allow-open`, `core:default` |
| `console` | bundled `index.html` (the status/settings page) | everything it has today, plus new `allow-desktop-reset` |
| `main` | the server's SPA over loopback | its same three commands plus window dragging, unchanged |

Mechanics:

- The wizard window is built the way the console is:
  `WebviewWindowBuilder::new(app, "wizard", WebviewUrl::App("wizard.html"))`,
  which resolves against the Vite dev server in dev and the bundle in prod
  with no config change beyond `rollupOptions.input` gaining the second page.
- Boot (`lib.rs` setup) **probes first, then branches on the probe's answer,
  never on the stored flag**: `probe_now` runs (with the § 4 marking on its
  result), and only the resulting `onboarded` value chooses the window. A
  machine set up entirely from the CLI therefore has `onboarded: true` by the
  time the branch runs and opens the console, which is § 4's "they never see a
  wizard" made structurally true rather than hoped for. The choice is a pure
  function, `boot_window(&Probe) -> Wizard | Console`, so the fixture test
  pins it directly.
- Anything that raises the "manage" window (menu item, tray,
  `desktop_open_console`) routes to whichever of the two applies to the
  machine's state: `onboarded` false means the wizard is the manage window.
  A user who quits mid-wizard and later picks a menu item re-enters the flow
  they left.
- The wizard's Done press closes `wizard`. Reset (which is what sets
  `onboarded` back to false) closes `main`, because its port just died.
- `wizard` is not recreated while it exists; a second request raises it
  (through `windows::raise`, the Wayland lesson applies to every window).

## 4. The `onboarded` flag

One new field on `crates/desktop-core`'s `Settings` (the app's own
`settings.json`, shared struct with Subshell Client, which ignores the field):

```rust
/// Set once this app has watched a server on this machine reach `ready`.
/// Decides whether boot opens the wizard or the status console. The struct's
/// existing `#[serde(default)]` covers the absent field in an old file; the
/// default is `false`, so an upgrade without a completed setup re-enters the
/// wizard, which re-walks a machine whose facts are already done in a couple
/// of Continue presses. That is the correct direction to fail.
pub onboarded: bool,
```

Marking rule, deliberately in one place: **`desktop_probe` sets the flag the
first time it computes `next == Ready`.** One rule covers every arrival:
the wizard's Run finishing, a recovery that took a half-run to ready, and an
instance someone set up entirely from the CLI (they never see a wizard, which
is correct; they chose their flow). There is no command to set it and no
argument that clears it; only `desktop_reset` clears it, as step 6 of wiping
the machine. `Probe` grows `onboarded: boolean` so the page reads the answer
from the round trip it already makes. The write lives in the command wrapper,
not in `probe_now`, keeping the pure probe pure and testable.

**Write safety, stated rather than assumed (R5).** Two windows may poll at
once (console at 5 s, wizard at ~1 s during a Run), so the first-Ready write
is a read-modify-write racing `binary_path` writes on the same file. Field
loss is already impossible: `SettingsState` is a `Mutex<Settings>` and
`update` locks, mutates, and saves as one act, so two writes serialize rather
than interleave. What is *not* safe today is durability: `Settings::save` is
one `std::fs::write`, and a crash between truncate and rename leaves a
truncated file that `load`'s `from_str().ok().unwrap_or_default()` reads as
"no settings", silently losing the user's picked binary along with the new
flag. This design therefore also changes `save` to temp-file-plus-rename in
the same directory, the same fix `plugins-seed.ts` made when its contents
became the record, pinned by a Rust test that a kill mid-save cannot corrupt
the previous file.

The wart, written down rather than discovered later: this ends the root docs'
claim that "both apps have the same two-window shape" (`.claude/rules/
security-context.md`). The server app now has three windows and the client
keeps two; § 11 carries the reconciliation.

## 5. The wizard

Five steps plus Done, linear with Back, a "Step 2 of 5" rail. A fresh probe
drives which steps are done (a reopened wizard lands on the first unfinished
step, and finished ones still show their facts). All page-side decisions live
in a new pure `ui/src/lib/wizard-state.ts`, tested without a webview in the
shape `config-form.ts` and `installers.ts` established; `wizard.html` +
`ui/src/wizard.ts` hold only DOM. The window polls `desktop_probe` on the
console's 5 s cadence, and during a Run at ~1 s (the run owns the state, so
the poll cannot race anything). No Refresh button, same argument as the
console's.

**1. Welcome.** Two sentences on what Subshell is, then the disclosure the
current `setup` hint carries, as bullets: installs the bundled server to
`~/.local/bin/subshell-server`, writes
`~/.config/subshell-server/config.env` (port 3080, all interfaces), registers
it to start at login, starts it. Nothing is downloaded. One button: Get
started.

**2. Prerequisites.** tmux, the hard stop every advancing verb shares. Three
states, all existing machinery: found (green row), missing with a plan (the
`tmuxInstallPlan` button: brew, or pkexec over apt/dnf/pacman/zypper), missing
without a plan (Mac-without-brew: the MacPorts line, copy-to-clipboard, "Read
the docs", and the poll that self-clears when tmux appears). If this build
ships no bundled server (`serverChoice: no-bundled`, a dev build), "Choose an
existing server…" sits here (the `pickBinary` / `setServerBin` pair). Continue
is gated until tmux answers. The gate stops forward motion only: the window is
a normal window, so close, quit, and the menu stay live on every step (R12);
the prerequisite that cannot be met is a state to leave the app in, never a
cell.

**3. Addresses.** The four configuration fields with the console's prefill
contract moved over whole: `effectiveForm` prefill, `explicitFields` semantics
(chosen-not-edited, so untouched stored values survive a save), the base URL
following an untouched port, `trustedOrigins` staying blank with its
"(optional)" label, `fieldProblems` rendered beside the field they describe.
The step's copy says defaults are right for most machines; the primary button
("Continue") works without touching anything.

**4. Agents (optional).** Not one offer but the built-in table: five rows,
Claude Code, Codex, Hermes, OpenCode, Pi, each with a one-line description and
an Install button driving the existing `desktop_install_agent` id contract
(Rust's `AGENT_INSTALLS` stays the execution authority; an unknown id is
refused there, not here). Installs are independent: none, one, or several; a
row whose command returned ok ticks to "Installed" (the dashboard's wizard is
the place that re-checks against the live plane, and it says so). No gate,
always continuable.

Terminal is deliberately **outside the list and outside the word agent**: a
separate quiet line below it, "No agent? You don't need one. Subshells can run
a plain terminal right now, with nothing to install, and you can add an agent
any time later." It is a real option on this screen and it is not filed under
a taxonomy it does not belong to.

A search/filter field is deliberately not built: the list is the built-in
table (the server is down, so the plane's plugin registry cannot be enumerated
from here, and only built-ins may auto-run at all, per the execution-authority
rule), and a filter over five rows is theater. When the registry makes the set
large, the right move is for this step to link the dashboard's agent settings
(a live, searchable, authoritative list), not to grow a second weaker one.

**5. Run.** The consent press restated: one button, "Set up and start", beside
the same bullet list as Welcome (what runs is what was disclosed). It calls
`desktop_setup`, which grows four optional address fields, and watches a
four-row checklist tick from **probe facts**, never from optimism:

| row | ticked when the probe says |
| --- | --- |
| Server installed | `probe.server !== null` |
| Configuration written | `probe.status.configEnv.exists` |
| Service registered | `probe.service.installed` |
| Server running | service `state === "running"` / `next === "ready"` |

The mapping is `rowsFor(probe)`, a pure function. The command itself keeps
running the chain in Rust: one authority for the order, and "stop at the first
failure so the probe names the remainder" survives unchanged. On failure the
chain's verbatim words render under the failing row, with Retry (idempotent
chain) and Back to Addresses (a wrong port is the ordinary culprit). On
success the probe marks `onboarded` and the checklist is full green.

`desktop_setup`'s new argument is an `InitPayload` all-optional
(serde-defaulted); empty means today's derived defaults, so the one-press
behavior is byte-for-byte the old behavior when the wizard's edits are absent.
The fields map through the existing `init_args`, so one argv assembly serves
`desktop_init` and the chain.

**Done.** "Subshell is running on this machine." Primary: Open dashboard
(closes the wizard; the SPA's Account → Agent → Launch wizard takes the
handoff). Secondary: Go to status page (opens `console` instead). Either way
the flag is already set, so the wizard does not follow the user around.

## 6. The deep link from the dashboard

Reset's entry is a danger-zone card on the dashboard's Settings page, shown
only when both are true:

- the viewer is an admin, and
- the page is running under this app's `SubshellDesktop` UA marker
  (`apps/server/web/src/lib/desktop.ts` already makes that branch; plain
  browsers never take it, and Subshell Client strips the marker and grants its
  remote window nothing, so the card cannot appear there).

Visibility is UX, not security: the security gate is the console-only ACL.

The button calls `desktop_open_console({ screen: "reset" })`. That optional
argument is the entire boundary change, chosen to stay small:

- It is an argument on a command `main` already holds, not a fourth command.
  `ipc-acl.test.ts`'s "main holds exactly three" pin remains structurally
  true and the ACL file gains no permission for `main`.
- Rust parses `screen` as a closed enum. Absent and unknown values both mean
  the plain console screen; the enum parse is tested.
- Delivery: Rust stashes the requested screen in app state, raises (or
  creates) the console, and emits a `desktop-screen` event at the window when
  its page is ready (on page load for a fresh window, immediately for a live
  one). The console page already has `core:default`, so listening is covered.
  The event switches the console page to its second view, the reset screen;
  there is no URL or path involved.

The honest worst case of the new reach, recorded in `docs/security.md`: an XSS
in a control plane's SPA can now raise this app's window **to a confirmation
dialog**. It reaches no execution. The reset command lives only on the console
window; the hostname must be typed by a human into the privileged window; a
remote page cannot read or type in another window's DOM. Raising a scary
dialog, with nothing behind it a remote page can advance, is the widened
ceiling.

Version skew, accepted rather than papered over: the SPA ships inside the
server binary, so the two directions of skew both resolve to "console raised,
no reset screen". Measured against tauri 2.11.5's `ipc/command.rs` rather than
asserted: the router derives every declared argument by looking up its own key
in the payload (`v.get(self.key)`), so an undeclared extra is structurally
never read (old Rust + new SPA), and `deserialize_option` answers a missing
key with `visit_none()` (new Rust `screen: Option<…>` + old SPA). The
combination itself requires adopting a newer installed server while keeping an
older app, which the app already nags about, and it degrades to a raised
window, never to a partial action.

## 7. Reset

### 7.1 The confirmation screen

A second view of the console page, entered only by the `desktop-screen` event
(there is deliberately no second entry: the dashboard card is the entry the
product owner chose over a console-resident one), and left by a Cancel link
back to the status view. It renders the blast radius with the **real paths
from the probe**, not approximations, plus the permanent things that have no
path:

- stop and uninstall the background service;
- close this instance's local panes (tmux servers it created; see step 3);
- delete `config.env` (path from `status.configEnv.path`);
- delete the instance's data: database (users, sessions, API keys, the node
  signing keypair), every pane log, the plugin store including installed
  third-party plugins, and the node artifacts (under the data dir unless
  `SUBSHELL_NODE_ARTIFACTS_DIR` moved them). Paths from the new `paths`
  block (§ 8), all permanent;
- clear this app's picked-binary choice and its `onboarded` state, so setup
  starts over;
- the installed server binary itself stays, and re-running setup reuses it.

Three disclosures that must not be buried, verbatim on the screen:

1. **Enrolled remote nodes are not reached.** Their agents, and any panes
   running there, survive with keys to a control plane that no longer exists.
   Re-setup means re-enrolling them.
2. **A `subshell` node agent on this very machine is not reached either**
   (R7), and this is the common machine: the root README says the control-plane
   host is usually also a node. Its daemon keeps running, holding its own
   config and key, dialing a plane whose database was just deleted, retrying
   forever; stopping it belongs to that app (Subshell Client, or
   `subshell service stop`), and § 13 keeps it a non-goal for reset to reach.
   "Back to virgin machine" means this app's machine, and the screen says so.
3. A server that **does not report its data paths** (an old CLI predating the
   `paths` block) gets a refusal with a plain explanation, not a guess. Reset
   never deletes a location it could not read from the machine's own
   authority. This is the `Unreachable`-is-never-`Init` rule taken one rung
   further: reset will not destroy data on a machine it cannot enumerate.

Confirmation is GitHub-style: type this machine's **hostname**, exact match,
to arm the button. The hostname shown (and therefore typed) comes from the
probe: `Probe` grows `hostname: string`, which Rust reads once by spawning
`hostname` and trimming (the webview has no way to ask the machine, same rule
as `platform`; memoized behind a `OnceLock` like the login-PATH probe, since a
running machine does not rename itself). `libc::gethostname` was considered
and declined: libc is not a direct dependency of either crate today (checked),
and one spawn through the `proc` discipline that governs every other
subprocess is cheaper than a new edge in the dependency graph. The **form**
is pinned because macOS makes `hostname` and `hostname -s` differ (R9): the
screen displays the exact string `hostname` printed, the comparison is that
same string, byte for byte, no short-form or case-folding leniency in either
direction, and the screen says "exactly as shown". The arming check exists twice on purpose and only once counts:
the page disables the button on a string compare against the probe's value
(UX), and `desktop_reset` re-reads the hostname itself and refuses unless the
typed argument equals it. The page names intent; Rust re-checks. That is
`desktop_open_path`'s closed-intent contract pointed at the one verb that
destroys, so it is pinned: the command takes the typed string and owns the
truth.

### 7.2 The execution chain

`desktop_reset` (new, console-only, through the ACL trio: permission entry,
`console.json` grant, ipc-acl pin). Shape copied from `desktop_setup`: one
chain, stop at the first failure, every CLI word verbatim in the returned log,
and **retry converges** because every step tolerates having half-happened.

1. **Read.** Spawn `status --json`; refuse to proceed unless it answers.
   Nothing is deleted from a machine whose state cannot be read.
2. **Stop.** `service stop`. "Not installed" and "not running" are tolerable
   answers, taken from the CLI's own exit behavior, not re-litigated here.
3. **Close orphan panes.** Each pane is its own tmux server on a socket named
   `subshell-<hash>` (`tmuxSocketFor`, `packages/pane-runtime/src/tmux-runner.ts`).
   The directory, precisely (R1): tmux resolves `-L <name>` to
   **`$TMUX_TMPDIR ?? /tmp`, NOT `TMPDIR`**, and the base is symlink-resolved
   (`tmuxSocketPath`'s `resolveExisting`, because macOS `/tmp` is a symlink to
   `/private/tmp` and the kernel binds the resolved path); inside it,
   `tmux-<uid>/` (the uid by spawning `id -u`, Rust std having no `getuid`).
   Getting this wrong does not fail, it finds an empty or absent directory and
   reports a successful reset with every pane on the machine still running,
   which is exactly why the rule is written out instead of approximated. An
   absent `tmux-<uid>` directory genuinely means nothing to kill; a present
   one is enumerated and every `subshell-*` entry gets
   `tmux -L <entry> kill-server`. The prefix keeps a user's own sessions
   untouched; the per-uid directory keeps other users' untouched (tmux itself
   would refuse the cross-user connect anyway). A kill that answers "error
   connecting" means the server is already dead: unlink the stale socket file
   and continue. Any **other** kill failure fails the chain there, because a
   pane that survived is a reset that lied. No tmux at all (impossible past
   setup, true on a weird machine) means nothing to kill. The prefix and
   directory rules mirror `tmuxSocketPath` and are pinned against it the way
   the installer table is (`include_str!` containment), so a rule change in
   pane-runtime fails this crate's build.
   **Same pass, same bug's other home**: `cleanSocket` (line 353) resolves
   `process.env.TMPDIR ?? "/tmp"`, which is wrong for exactly this reason and
   has been silently failing best-effort forever; it moves to
   `tmuxSocketPath` (which already encodes the correct rule) and gains a test
   that a socket under `TMUX_TMPDIR` is the file it unlinks.
4. **Uninstall the service** (`service uninstall`), while the binary and
   config it names are still on disk and the CLI is still the authority on the
   unit file.
5. **Delete**, in this order and no other: the database file, the logs
   directory, the node-artifacts directory, the data directory recursively
   (the default layout nests those three inside it, so the recursive delete is
   the same bytes; overridden paths stand alone), and **`config.env` last,
   the file, not a side sentence** (R4). The order is load-bearing:
   `config.env` is what tells `status --json` where the overridden paths are,
   so if it went first, a Retry after a partial failure would re-read a
   machine with no config, resolve every path to its *default*, delete nothing
   that exists, and report success with the operator's real data directory
   untouched. Deletion of it is therefore the chain's point of no return and
   runs only once every directory it points at is gone.

   Only paths the `paths` block reported, each under two layers of refusals.
   **Shape** (as before): absolute, exists, not `/`, not the user's home
   itself, final component not a symlink. An operator-configured `/data` is
   legitimately theirs to lose, so the guard stays shape-based rather than
   location-based. **Containment** (R3), which protects the promise on the
   screen rather than a location: a directory to be deleted is refused if it
   contains, or equals, the resolved server binary path or the directory
   holding `config.env`. Without it, a data dir configured as `$HOME/.local`
   passes every shape guard and takes `~/.local/bin/subshell-server` down with
   it, while the confirmation screen promised the binary stays. The compared
   paths are ones the probe already carries; the check is a pure
   `delete_guard(dir, keep) -> Result`, and it refuses before anything in the
   chain has touched the disk.
6. **Clear app settings:** `binary_path` to none, `onboarded` to false.
7. **Windows:** close `main` (its port is dead), close the console, open the
   wizard at Welcome. The chain's final result log is shown by the wizard's
   ordinary first probe, not smuggled anywhere.

A failure mid-chain leaves the reset screen up with verbatim output and Retry.
The half-deleted machine is exactly the state Retry walks out of: step 1 still
answers (deleting data does not silence `status`; `configEnv.exists` and the
`paths` block still resolve to their configured locations), and delete steps
tolerate absence.

## 8. The one server-side addition

`subshell-server status --json` (`apps/server/api/src/commands/status.ts`)
gains an additive block:

```jsonc
"paths": {
  "dataDir":       "<SUBSHELL_SERVER_DATA_DIR, resolved absolute>",
  "database":      "<DATABASE_PATH, resolved absolute>",
  "logsDir":       "<the per-subshell logs directory, resolved absolute>",
  "nodeArtifacts": "<the node-artifacts directory, resolved absolute>"
}
```

These are that process's own resolved constants, which makes the CLI the
authority on where its data lives, exactly as it already is for `config.env`
and the log file the plist names. It is types-only-visible to the console via
the forwarded `StatusBody`, optional there (an older server lacks it, and §
7.1's refusal owns that case). The AGPL/Apache line is unaffected for the
structural reason, not a behavioral one: `apps/server/desktop` is itself
inside `AGPL_PREFIX` (`scripts/license-fields.ts`, `"apps/server/"`), so
`@internal/desktop-server` is AGPL and anything it imports from
`@internal/server` is AGPL-to-AGPL, not a crossing at all. (This paragraph
first argued "the console consumes it as opaque JSON", which is true but the
wrong premise: it would stop being load-bearing the moment the console moved
out of `apps/server/`, which is exactly when this note would next be
consulted. No `PERMITTED_CROSSINGS` entry is needed either way.)

## 9. Contracts, complete

| surface | change | kind |
| --- | --- | --- |
| `crates/desktop-core` `Settings` | `onboarded: bool`, serde-default false | additive field |
| `desktop_probe` | marks onboarded on first Ready; `Probe.onboarded` and `Probe.hostname` | behavior + fields |
| `desktop_setup` | optional `InitPayload` argument (four fields, serde-default) | additive argument |
| `desktop_open_console` | optional `screen` argument, closed enum | additive argument |
| `desktop_reset` | new, console-only | new command + permission |
| `status --json` | `paths: { dataDir, database, logsDir, nodeArtifacts }` | additive field |
| `desktop-core` `Settings::save` | temp-file + rename (was one `fs::write`) | bugfix, pinned |
| `pane-runtime` `cleanSocket` | resolve via `tmuxSocketPath`, not `TMPDIR ?? /tmp` | bugfix, pinned |
| `capabilities/wizard.json` | new capability file, exact-invoke set | new file |
| `ui/` | `wizard.html`, `ui/src/wizard.ts`, `lib/wizard-state.ts`, console second view, Vite multi-input | new page + views |
| `apps/server/web` Settings | danger card, admin + desktop marker, calls `openConsole({ screen: "reset" })` | new UI |

## 10. Error handling

- Every chain failure surfaces the CLI's own words verbatim (the standing rule
  that two surfaces phrasing one refusal differently is drift).
- The wizard never disables a control without naming the reason beside it (the
  tmux warning pattern, extended to Run's gate).
- The console's poll and the wizard's idle poll skip while an action is in
  flight and while hidden, as today. The Run's fast poll is not a third
  mechanism: it is the run's own settle loop, single-flight exactly like
  `guard()`'s settle is today, which is why "skip while in flight" cannot
  strangle it.
- `desktop_reset` is `Result<ActionResult, String>`: an `Err` is a refusal to
  start (hostname mismatch, unreadable status, missing `paths` block, refused
  deletion guard), never a half-run; a half-run is `ok: false` with the log
  showing where it stopped.

## 11. Testing

The creed holds: pure decisions pinned without a webview, contracts pinned
across the boundary they drift across.

**TypeScript (`ui/src/__tests__/`, `bun test`):**
- `wizard-state.test.ts`: step done/available/current from probe fixtures
  (virgin, half-configured resume, ready-at-boot); `rowsFor` mapping and the
  failure case; prerequisites gating incl. `no-bundled`; agent row states.
- `reset.test.ts`: `resetPlan(probe)` pure half: path rows from the `paths`
  block, the no-block refusal line, arm/disarm string compare behavior (the
  Rust check is the gate; the test name says so).
- `ipc-acl.test.ts` extended to four files: wizard's invoke set == wizard's
  grant set; console gains exactly `allow-desktop-reset`; main still exactly
  three commands + window dragging; nothing defined-but-ungranted.
- `tauri-config.test.ts`: `frontendDist === "../ui/dist"` unchanged, second
  Vite input present, both pages CSP-clean by the same build rules.
- config-form tests extend: `desktop_setup` payload goes through
  `configPayload`, chosen-not-edited semantics unchanged.

**Rust (`cargo test`, both crates as applicable):**
- `onboarded` serde round-trip, default false, old file reads.
- mark-on-first-Ready in the command wrapper (`probe_now` stays pure).
- `open_console` screen enum: absent, unknown, `reset`.
- `boot_window`: ready-at-boot with a stored `onboarded: false` picks
  **Console** (the CLI-provisioned fixture from R6), virgin picks Wizard.
- reset hostname compare and the deletion **shape** guards (rejects relative,
  `/`, home itself, symlink final component; accepts an absolute `/data`).
- reset deletion **containment** guard (R3's test): a data dir of
  `$HOME/.local` containing the resolved server binary is refused outright,
  and so is one equal to the config directory.
- chain order (R4's test): the pure plan assembly puts `config.env` after
  every directory deletion, asserted as order, not inferred from layout.
- `Settings::save` writes via temp + rename in the same directory and leaves
  no temp file behind (R5's fix, pinned per behavior).
- tmux socket prefix **and directory** mirror pin against pane-runtime
  containment test as the installer table uses; it covers `TMUX_TMPDIR`,
  `tmux-<uid>`, and the resolve-the-symlink rule.
- `bun run rust:check` (fmt + clippy -D warnings + tests, all crates, with the
  stub-sidecar staging the script already does).

**Server and shared packages:** `status --json` gains a pin for the new
`paths` fields' values against the constants module (the same test style that
keeps `configEnv.path` honest). `pane-runtime` gains the `cleanSocket` test: a
socket under `TMUX_TMPDIR` is the file it unlinks (today's `TMPDIR`-based
resolution would miss it, which is how R1 was found). e2e: the danger card is
invisible in bare Chromium (no marker), asserted where the suite next visits
Settings.

**Verification gate for the whole change:** `bun run verify-types &&
bun run lint:check && bun run test`, plus `bun run rust:check`, plus
`turbo build` (the server change must reach `backend-client`'s inferred types
even though no consumer needs the new field yet).

## 12. Docs and release housekeeping

- `apps/server/desktop/AGENTS.md`: "The two windows" becomes three, with the
  wizard lifecycle, the onboarded rule, the deep link, and the reset chain
  written in the same measured style (including the Wayland raise and
  tuck-console rules gaining a third window).
- `.claude/rules/security-context.md`: the "both apps have the same two-window
  shape" sentence revised (server app: three; client app: two, boundary
  argument unchanged); the desktop section gains the reset accounting: the
  deep link's true worst case, hostname-as-Rust-truth, the no-paths refusal,
  remote nodes not reached.
- `docs/security.md` (the authoritative model): the matching desktop section
  update the rules file summarizes.
- `apps/server/desktop/README.md`: first-run description becomes the wizard.
- Changesets: minor `@internal/desktop-server`, minor `@internal/server-web`,
  patch `@internal/server` (additive `status --json` field).
  `crates/desktop-core` and `packages/pane-runtime` are not changesets
  packages (one is a path-dep Rust crate, one is private); their changes ride
  inside the app cuts that bundle them, which is why the pane-runtime
  `cleanSocket` fix reaches users via the next `server`/`desktop-server`
  release rather than needing its own bump.

## 13. Non-goals

- A search/filter box over the built-in agent table (§ 5's argument; the live
  registry list in the dashboard is where search will belong).
- Reset reaching remote nodes, re-enrolling them, or any per-node reset, and
  reset stopping or removing a `subshell` node agent on the same machine
  (§ 7.1's third disclosure: that daemon belongs to Subshell Client).
- Any reset entry on this machine's CLI, in Subshell Client, or in a plain
  browser (the command and the card both have exactly one home).
- Changing the SPA wizard, the probe state machine, the `no-bundled` dev-build
  path beyond what § 5 already says, or the tray's shape.
- Re-opening the wizard on demand for an onboarded machine ("Run setup again"
  is what reset is).
