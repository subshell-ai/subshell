# The node page is an assistant: screens, rails, and rulings

Moved from `apps/client/desktop/AGENTS.md`, which keeps the operational
summary and routes here. The text below is verbatim.

## The commands that arrived with the first run

(Split from AGENTS.md's "The IPC boundary"; they serve the assistant's screens.)

**Two commands arrived with the first run** (spec 2026-09-18), both granted to
the `node` window alone:

- **`node_install_tmux`** installs tmux, so this app can offer what Subshell
  Server always could. The table it runs is `crates/desktop-core`'s
  `tmux::install_argv`, SHARED with the server rather than copied, which is
  why the argv lives in the crate and not here: brew on macOS (nothing
  runnable without it), `pkexec apt-get` on Linux (never a bare `sudo`, which
  from a GUI has no tty and hangs to the timeout). The install is streamed
  through a `LineSink`, `emit_to` the NODE window, not a broadcast, because
  this app's other window is a control plane's own page and a package
  manager's output is not its business. (This bullet said the sink was a no-op
  "because its tmux screen listens for nothing"; that stopped being true when
  the screen grew its progress pane, and the emit's own comment in
  `control.rs` says so.)

  **A failed install is a state the screen renders** (2026-09-18, spec
  `2026-09-17-zero-touch-desktop-setup-design.md` § 11): `tmuxInstallFailure`
  in `lib/copy.ts` (mirrored from the server app beside `manualTmuxRoutes`,
  so a diff between the copies is the drift signal) forks on the result AND
  on whether tmux turned up, because an install that exits ZERO and leaves
  none was indistinguishable from a button nobody had pressed. It matters more
  here than there: the runner's generic failure line is "That did not work.
  See the output below", and this screen renders no `DetailsDisclosure` for it
  to point at, so a failed install said nothing at all. The card carries the
  app's own headline, the manager's last word and both streams behind Show
  output; the button relabels to **Try again**, and `NodeCommands.installTmux`
  re-probes before it spawns anything: the poll is paused while an action is
  in flight, so someone who fixed the machine in a terminal is pressing that
  button to say "look again". A tmux found there returns without spawning, and
  the screen leaves by itself as it always did.
- **`node_plane_add`** remembers a control plane WITHOUT opening anything.
  It exists because `node_open_plane` does both, and the first run's connect
  step must do only the first: a dashboard that appears mid-setup is the
  defect that whole flow removed. Its pair `node_plane_remove` Errs on a row
  that is not stored (the page names only rows it renders; silence would
  lie); both compute through pure `plane_list_*` helpers that canonicalize,
  dedupe, and refuse the node's own address, because that address renders as
  the pinned row and two rows for one plane is what the pinned row exists to
  prevent. `node_set_plane`, the single-address ancestor, is GONE with the
  plane-list ruling below.

`node_service` also gained `autostart` beside `force`. It has two jobs and no
others: on `install`, `false` spells `--no-autostart` (the flag that installs
and runs the service but does not arm login start); on the `autostart` VERB
(rails addendum, 2026-09-22: the day-2 login toggle the server's supervision
screen always had), the boolean IS the request and spells the CLI's two-word
`service autostart on|off`. The Rust side passes the flag on `install` and the
word on `autostart` and refuses both anywhere else, exactly as it refuses
`--force` outside `restart`: the CLI's flag allowlists are per-subcommand, so
the wrong pairing is a usage error rather than a no-op. The probe surfaces the
service's answer `autostart` the way it surfaces the whole `service status
--json` body (verbatim, an untyped passthrough) so no Rust field could
disagree with the CLI's, and an agent too old to answer it reads through
`enabled`, the same fact every agent has always reported.

## The node page is an assistant

One screen at a time, each asking exactly one question, in the same frame
Subshell Server's setup assistant uses, so the two apps read as one product
(spec 2026-09-12 § 6.4). It was seven stacked cards that showed everything at
once and asked nothing in particular.

**The routing is `lib/client-flow.ts`, and `screenFor` is gone** (spec
2026-09-18). It answered "which screen does this machine imply", and the first
run needs the question that comes BEFORE that one: what did this person come
to do. `clientScreen({probe, settings, step, override})` answers both, in that
order: nothing read yet ⇒ `null`; a screen the user asked for; the in-memory
walk (`FteStep`), which outranks the next rule because enrolling settles an
address mid-chain; a CONFIGURED client ⇒ **status**; a half-built machine ⇒
**register**; otherwise **welcome**. `lib/node-assistant-state.ts` keeps the
vocabulary (`NodeScreenId`, `screenTitle`, `serviceAction`) and no longer
decides anything. There is ONE router, deliberately: two functions answering
"which screen" is how they come to disagree.

**The rail is for the standing screens, and only for a settled machine**
(wave 3 and its follow-ups; the same rulings the server wave carried, by the
operator, 2026-09-22). `railFor(screen, settled)` in `lib/client-flow.ts` is
the rule as data: the six sections **Control Plane**, **Status**,
**Service**, **Update**, **About**, **Reset** (destructive, styled in the
destructive token) appear only when the machine is settled (`configured()`
and no `FteStep` in progress) and the screen is one of the standing kinds,
and they answer `null` for every step of the FTE walk, for the focused act
(re-enroll, the same kind of moment) and for the not-read state, and for
any standing screen while the machine is NOT settled, because the exclusion
is about the machine's journey, not about who asked: the tray can raise
About mid-walk, and that render keeps its Back. A select is the navigation:
every select sets its override now (see the landing ruling below). Reset's
CONFIRMATION rides the rail (operator ruling 2026-09-22, final word on the
reset layout, superseding the frame-replacing premise for the confirmation
(now itself superseded; see the dialog addendum below):
the sidebar was being lost today and that is not wanted); the room is the
RUNNING chain: from the confirm press to the chain's end, reset-screen.tsx
hides the rail off the runner's busy and renders no exit, and no navigation
sits beside a chain that is deleting this machine's node. The press itself
STAYS through the chain, disabled and labelled "Resetting…"; the bar
emptying the moment the one irreversible button is pressed reads as a hung
window, not a running chain. That is the server room's busy affordance; the
server can also draw its step meter, and this app has no step events to draw
one from, so the label is the whole of it here. There is NO CANCEL
where the rail is present (operator ruling 2026-09-22, screenshot 59): the
rail is the way out of the confirmation, and the room keeps no Cancel
regardless; the not-registered refusal reads "This machine is not registered
with a control plane." and the subtitle is "Removes the machine's Subshell
node configuration and data." (both the operator's exact words, same
screenshot); and where the rail
is up, the standing
screens' own leave buttons (About's and Update's Back) render only where the
rail does not. The tray's `desktop-screen` events select their section by
the same override state: no new command.

**The status screen keeps machine state, not the node's machinery** (the
follow-up rulings, 2026-09-22, live screenshots). What moved out of it and
where: the node's install offer (the bordered card titled **Register as a
node**, addendum 3, the operator's exact words; the explainer sentence pair
is DELETED, a later ruling the same day; the button speaks for itself, and
it reads **Install the Subshell Node CLI**; the disabled-no-bundled case
keeps the title and shows only its sentence), its
refusal for a CLI that cannot state its own status, the contextual service
verbs, the pane-safety rewrite door and the unrecognised-state card, all to
the **Service** section, whose subtitle carries the "what is a node" half the
explainer dropped (the node's reveals joined them on 2026-09-22, left with
the bar, and came back onto Status's OWN fact rows on the same day's second
round, misplaced, not surplus); the
configured plane address, the way to change it, "Open in browser instead",
and the node's own view of the same server (its repoint machinery, the
loopback notice and the coherence card), all to the **Control Plane**
section, which shows the address labeled rather than narrating "This app
opens <url>". **Re-enroll…** moved there too, later the same day (operator
ruling 2026-09-22): overwriting `config.json` and minting a second node row
is an act on this machine's relationship to the plane, not on the machine
itself, and the enroll screen's confirm gate is unchanged. **Register this
machine** moved to the Service section beside the install offer (later the
same day, screenshot 60, the node's machinery home); same handler, same
walk entry, its override-clearing wiring re-traced to the new screen, the
card titled **Enroll this machine as a node** (the operator's exact words,
the one card-title style) with its long blurb deleted, so the status
screen offers NO act at all. The node-behind
doors the status screen carried ("Update the
node to X…", "Check for updates…") are GONE: the Update section is the door,
and the update screen's own table is where the node row's numbers live. The
the facts render INLINE (no disclosure) on the STATUS screen ALONE
(operator ruling 2026-09-22, screenshot 60, superseding the screenshot-52
scoping: one list, one panel, the `bundled` and `tmux` rows back in). A
screen that needs a fact to explain a state says it in its own card's
sentence; the CLI's last words render as the output block on the screen
that owns the action, and the config fact's value is PLAIN LANGUAGE:
"Not enrolled. Go to Service to enroll." for the enroll-pointing reason,
"The node's configuration could not be read." for any other; the raw CLI
words render only as an action's failure output. Unregister is not a link on the status
screen; the rail's Reset item is its ONLY entry (one act, one door, one
label), and since the dialog ruling that item opens the confirmation over
the standing section instead of selecting one. There is no Refresh button
anywhere: the probe query re-reads the machine on its own five-second interval
(operator ruling, 2026-09-22): the poll is the refresh.

**The output block travels with the screen that owns the action** (operator
ruling 2026-09-22, extending the same day's opens-record-nothing rule). An
OPEN records no receipt (the window or browser opening is the feedback), and
an instantaneous save records none either; the runner output's remaining
job is LONG actions' CLI words and FAILURES. What is recorded renders only
on the screen the action was pressed on: `App` tags each outcome with its
screen at press (`useActionRunner`'s `onRun`) and gates the render, so the
reset screen never shows another action's line. The Update screen's own
watch-verdict reads the raw runner output, which is why the rule gates the
render rather than the record. **Every screen that renders the block is
gated**: the fix wave (2026-09-22) found Service and Control Plane still
handing it the raw `runner.output`, a half-gated state where Service's Start
answer followed the person onto the plane cards while the explaining failure
line stayed honest. And a SUCCESSFUL enroll records no visible receipt under
the same ruling: the enroll screen unmounts on success, its words render
nowhere, and the status facts ARE the proof, the opens-record-nothing
precedent, not an oversight; no handoff mechanism exists or is wanted.

**The doors rearranged the same day, twice** (operator rulings 2026-09-22,
screenshots 52/53 and a superseding addendum). The FINAL state: the status
screen carries NO door at all: anything that opens the control plane lives
on the Control Plane section alone, under a **Dashboard** card with both
doors, **Open in browser** (`node_open_plane_url`, the system browser) and
**Open in app** (`node_open_plane`, the in-app window at the re-read settled
address). Control Plane is also the LANDING and reads first in the rail:
`clientScreen`'s configured case answers `plane`, the rail order is Control
Plane | Status | Service | Update | About | Reset, and because "clear the
override" no longer meant "show Status", EVERY rail select is an override
now, Status included. The plane address row is the server Addresses card's
form shape (screenshot 53: the one-line value with its buttons beside it
wrapped the URL character-broken); since addendum 4 a bordered CARD
labeled **Control plane URL** (the operator's exact words) holding the value
and the acts (Change server…, Re-enroll…), with the Dashboard card below
it. The `no-node` badge
reads **Not registered as a node** (house sentence case, over the operator's
typed capital-N), and the status screen's "This machine is not a node yet…"
sentence is DELETED: the badge already says what the machine is not. The
plane-coherence notice leads with the conflict now (review, 2026-09-22):
"This machine's node reports to <node>, not <plane>.".

**Service joins the server's layout, and the badge joins the header** (the
same day's follow-up, rails addendum: "consistency in offering and UI").
The Service section now offers what Subshell Server's Service offers, adapted
to a node: the arrangement stated as one card (**In the background**, naming
no manager), the run-at-login switch nested under it
("Start automatically on startup"). The named thing is the **Subshell
Node Service** (the server app: the **Subshell Server Service**), and the
card STATES THE CURRENT CONDITION ("Currently the Subshell Node Service
runs in the background, but does not automatically start on startup.")
while the switch help says what flipping it changes. The first-run
question keeps its shorter "Start at login": the walk's own wording stands).
For an installed service come the lifecycle verbs (Start when it is down,
Stop and Restart when it is up with the pane-safety force flow unchanged,
Uninstall confirmed in its own words), and the install-service door for a machine whose
node CLI is installed but whose service is not, driven by the definition,
not only the step word, so no enrolled "nothing installed" answer can miss it.
Node-specific differences stay: there is no app-managed-child supervision
choice, because this app does not supervise its node that way. The two
bottom-bar **reveals are gone from the bar** ("feels out of place... remove
them"), and round two (same day) put the affordance back where the server's
has always sat: inline on the Status fact rows whose value IS a path, with
`node_open_path` restored unchanged, permission included, as one atomic ACL
commit. On both standing screens the
STATE BADGE reads in the Frame header between the title and the subtitle:
the client's `Frame` grew an optional `badge` slot; the shared package Frame
is untouched, because the server's Status section has no badge to move. The
switch is only honest because the node CLI gained the verb behind it (see
`apps/node/agent/docs/service.md`), and it is gated on that
verb: an agent older than `0.15.0` can READ the state (it has answered
`enabled` forever) but cannot WRITE it, so the switch shows the answer
greyed with "Currently the installed version cannot change this. Updating
to version 0.15.0 lets you." (`lib/autostart-gate.ts`, the server's
`MIN_AUTOSTART_SERVER_VERSION` pattern; the server app keeps its own shorter
sentence for its gate). Where neither `autostart` nor `enabled` answered,
the switch greys showing no guessed value, the help line stays empty, and
the card itself carries the fact: "Whether it starts on startup is not
reported." The switch's help states the CURRENT condition in every state it
can speak (armed, disarmed, too-old). Operator ruling 2026-09-22: the card
says what is, the toggle says what flipping it changes.

**Control Plane became a list, and the node's binding moved to Service** (the
same day's plane-list wave, superseding everything above about the plane
cards, the Dashboard card's two doors and where Re-enroll… lives: "the
control plane section is for connecting to other control planes, not
necessarily tied with the node"). The section is a BARE TABLE, not a card:
the node's own address renders as a PINNED first row badged **this node**
(`probe.status.serverUrl`: a probe fact Rust refuses to store as an entry),
stored addresses below it. Pressing a row IS the dashboard door; the `⋮` opens
a real ACTION MENU (Open in dashboard, Open in browser, Copy URL, Remove) positioned
BY CLASS (`absolute right-0 top-full` in the row's own `relative` box) at a
FIXED width, which the CSP permits even though it outlaws the style attributes
a measuring popper writes. Both rulings of constraint came from the live
window the same hour: the auto-width panel sized itself to the ROW rather
than its labels once the `w-full` items counted in ("why is the action menu
so wide"), and button-sized items made the panel read oversized (items are
the dense menu scale: `h-7`, `font-regular`, `text-detail`, shorter than
the app's smallest button). Escape and an outside press dismiss it, one is
open at a time, and `ipc-acl`'s argument pins keep every plane command to the
one argument: the address. The pinned row's menu holds the SAME opens plus
Copy URL ("what about open in browser?": to connect, it is a plane like any
other), no Remove, and no sentence explaining the absence either, but the
ROUTE stayed as a plain **Go to Service** item ("what happened to going to
the Service section": the explanatory note was deleted the same hour
Un-enroll… stood up there; the pointer to it survived as one item, because
the absence of Remove says nothing without a door). Copy
is the `CopyButton` affordance in text form: the menu's dismiss is the
success flash, and a refused clipboard keeps the menu open and renames the
item rather than flashing nothing. The add is the frame's bottom bar in the bar's
own grammar: opener primary-right. The FORM is a dialog (the audit's last
inline pane), Add its primary, Cancel its ghost, Enter submits, and like
every save after it the dialog CLOSES on submit, because the refetched list
underneath is the entire validation and dedupe feedback and a modal that
stays open says nothing. `plane-coherence.ts` was deleted with the
two-address state it existed to detect (the pinned row IS the notice), and
the Status subtitle now states the MACHINE ("This machine is a node of
<url>." / "This machine is not a node."), because a watcher has many planes
and none of them is current. `settings.plane_url` became `planes:
Vec<String>` in `crates/desktop-core` with NO migration (there are no users;
an old `planeUrl` key reads as nothing), and `node_set_plane`,
`resolve_plane_url` and the boot-open ladder are deleted outright: spec
2026-09-18 § 2 says a client never opens a plane by itself, and the ladder
only ever fed a `debug_assert`. FTE Connect retargeted to `addPlane`.

**Service's Enrolled to Control Plane card holds the node's binding acts**:
the address, the enroll-time loopback notice that moved with it, **Re-enroll…**
and **Un-enroll…**, the destructive half. Re-enroll… is the ENROLLMENT
WIZARD's door (operator ruling 2026-09-22, an hour after the dialog wave:
"Re-enroll should go through the enrollment wizard"); it opens the same walk
the Register card opens, seeded with the current address, and the bespoke
free-form repoint field it displaced went all the way down with its
`node_configure` command, from `ipc.ts` to the capability file. Re-enrolling
IS enrolling again: it spends a setup key and mints a fresh node row, and the
guard against overwriting a live config is the walk's own two-phase confirm,
not a second gentler surface that taught the cheap CLI act (`subshell
configure --server`, still a CLI verb, now one this app never calls) is what
the button does. The two are deliberately SEPARATE commands (operator, same
day: "let's keep them as separate commands"): Uninstall on the background
card keeps its narrower meaning even though the un-enroll chain happens to
tolerate a machine with no service. Its confirm states the orphans ("Subshells that are still running keep
running, but nothing will manage them." / "The control plane keeps its node
row until its owner deletes it there."); accepting makes ONE `node_unenroll`
call, whose chain is Rust's: stop, uninstall the definition (each tolerating
"nothing installed" so a Retry converges), then the node CLI's new
`unenroll --yes --json`. The order is the safety property: a kept definition
respawns a daemon against a deleted config, so the definition goes first; the
chain deliberately carries NO copy of the reset's tmux-kill half: panes
outliving their node is this product's design, and the confirm is where that
truth is read, not discovered. The card is gated on the verb existing
(`lib/unenroll-gate.ts`, `MIN_UNENROLL_NODE_VERSION = "0.15.0"`, the
autostart gate's twin over the shared `lib/semver.ts`): an older agent would
have its service stopped, its definition uninstalled, and only THEN answer
`unenroll` with a usage error, unmanaged and still enrolled.

**The press narrates its own button** (two more live-window rulings of the
same hour: "when clicking restart, there should be a spinner saying
restarting. same with the stop / start button", and "when restarting this
additional message occurs, can we remove it"). The runner carries the
in-flight submission's `label` (`start`, `stop`, `restart`, `uninstall`,
`unenroll`, `rewrite`: set at the `runner.run` call), and the button
wearing that label shows a spinner and the progressive word; the row's other
buttons keep their plain words even while disabled, so what is waiting is
never ambiguous. `accept()` carries the label through a confirmation, so the
confirmed chains (Uninstall, Un-enroll, the forced restart) spin from the
dialog's Accept to the answer rather than only from the first press. And a
starting act (start, restart's two phases, service install, the rewrite)
does not END when the CLI returns: the runner's `confirmStarted` re-reads
the probe until the node is ONLINE, or until `START_CONFIRM_MS` (30 s) says
it is not coming within the window, so the spinner means exactly "confirmed
started or unable to start" (ruling, same window: "keep it spinning /
disabled until it's confirmed started or unable to start"; measured, a
throttled launchd kick takes 10–30 s and the CLI returns instantly).
`stop` keeps the bounded settle; its answer is the absence and it arrives
fast. While a starting act runs, the header state chip wears the act's word
too ("why does it say online while it's restarting?"): the probe's last
read is stale for seconds on purpose (its online verdict is heartbeat
freshness, which outlives the kill signal, and the manager's exit timeout
outlives the click), so repeating it mid-restart reads as a lie; the chip
returns to the machine's verdict when the act ends. The card's problem
sentences stay quiet while any of this runs, plus
`PROBLEM_GRACE_MS` (one residual probe cycle; the confirmation lives inside
the act now), and a stop keeps no grace at all: its sentence is the point of
the act. What survives is written as the screen's WARNING band (same-day
ruling: "if this is something we want to inform the user of, it should
probably be written as a yellow warning"), on a probe that is no longer
anyone's in-flight press. No timer of ours narrates the hush's end: the
probe's own poll re-renders the quiet away. STOPPED keeps no sentence at all
(later ruling the same night: "just remove this, the badge already shows the
status"; the chip reads "Service stopped" and the sentence said it twice);
OFFLINE keeps its pair because it names a disagreement the chip cannot show,
and NO-SERVICE's because the sentence stands beside the door that ends it.
And a SUCCESS on this section
leaves no receipt line (same hour's ruling, on the "subshell restarted."
block: "just remove it, the user won't notice it anyways"): the card
rendering `ActionOutput` gates on `output?.ok === false`, so refusals still
answer verbatim in the monospace block and successes say nothing; the
runner still RECORDS the success, because the Update screen's verdict watch
reads that record; the Service section just declines to show it. (This is
also why the confirm wait refetches BEFORE its first cache read: the cached
probe is the pre-kick machine, and checking it first returned the wait
instantly; the live window called that out as the old bug back.)

**Confirmations answer in a dialog now** (operator ruling 2026-09-22: "use a
dialog when it comes to user confirmation … rather than rendering another
pane in the panel", then the audit ask). The audit's answer is ONE mount
point, so the change is one component: every confirmation the app raises is a
runner `asks()` outcome, every `asks()` outcome renders through
`ConfirmPanel` at the single `shell.confirm` slot in `app.tsx`, and
`ConfirmPanel` is now the app's own `Dialog` (`components/ui/dialog.tsx`),
a class-positioned fixed overlay with no measuring popper, so the CSP note
in `confirm-panel.tsx` still holds (style ATTRIBUTES are outlawed; classes
are not). Escape and a backdrop press ARE the cancel; the accept keeps its
weight on the right. The dialog is labelled, which is what keeps an accept
button that shares its words with the button behind it ("Enroll this
machine") tellable apart by both a screen reader and a test:
`confirmPanel()` scopes to `role=dialog` now. Reset followed within the
hour: the rail keeps its **Reset** item and pressing it opens **Reset
everything?** as a dialog over whatever section stands (paths, the five
disclosures, and the typed-hostname gate all inside it), and it is a DOOR,
not a section: it overrides nothing and activates nothing in the rail, so
the standing screen keeps its highlight underneath. While the chain runs the
dialog cannot be dismissed (Escape and backdrop inert, Cancel disabled, the
press relabels "Resetting…"): the old frame-replacing room's no-way-out rule
expressed harder. Completion closes it and the words land on the section the
press happened on, like every other action (`reset-dialog.tsx`; the
`reset` id is gone from `NodeScreenId`, `NodeUserScreen`, the titles and the
subtitles; `CLIENT_RAIL_SECTIONS` keeps the danger entry as the door).

Three screen ids went with it, and their absence is the design.
**`connected`**, **`service`** and **`install-agent`** were the probe-derived
landings; their content is distributed across the rail now: the service
verbs on **Service**, the split that decides whether
registering may be offered at all on **Status** (below); the configured
client lands on **Control Plane** (operator ruling 2026-09-22, second
addendum; it was `status` until that afternoon). A screen nothing can
route to is not a recovery path; it is dead code that reads like one.

An address no longer comes first, either, and that reversal is load-bearing:
`configured()` counts an ENROLLED machine as well as a stored `planeUrl`,
because the walk ends at Register and Register on a node mints a second node
row and discards its node key. Screens a person ASKS for rather than states
a machine implies (re-enrol, reset, plus about and update) arrive as the
`override`, and since the landing moved to Control Plane, EVERY rail select
is an override too, Status included, or a Status select would clear the
override and land on Control Plane with Status highlighted nowhere. `update`
is the one the MACHINE may also raise: an app update left a marker, and the
process that boots into it opens the screen once per launch to finish the act
(see "Updating is ONE act" in `apps/client/desktop/docs/updates.md`).

**`no-node` reads two ways, and status must keep them apart.** The Rust side
folds "nothing on the ladder answered" and "a binary answered `version` but not
`status --json`" into one step on purpose (control.rs says why). Where nothing
answered, installing is safe unconfirmed and is offered ON ITS OWN, not folded
into Register, because a machine with no node cannot say whether it is already
a node and the register chain enrols with `confirm: true`. Where a binary
answered but could not report, NOTHING is offered: the remedy is a different
binary. Registering is also withheld over a probe that could not be read at all
and over a step this build predates. That was `install-agent-screen.tsx`'s whole
reason for existing; it is `status-screen.tsx`'s now.

`app.tsx` is a host and nothing else: it reads the machine, holds the action
runner and the enroll form, and composes the shared half of the frame (title,
subtitle, the problem line, the confirmation, the footer). Each screen owns its
icon, its content and its bottom bar.

What the shape changed, and why:

- **Facts moved under "Show Details".** A person opens this window to DO
  something, not to read twelve fields. `lib/probe-facts.ts` is unchanged and
  still the only reader of the probe's shapes; only where it renders moved.
- **Stop and Uninstall left the app, then came back.** Restarting a node is a
  control-plane action too (spec 2026-09-12 § 6.3, `POST /api/nodes/:id/restart`),
  and Reset tears everything down, but the rails addendum (2026-09-22,
  server parity) put the full lifecycle back on the Service section: an
  installed service that is running gets Stop, Restart and Uninstall there,
  one that is down gets Start. The pane-safety rule is unchanged: Restart is
  still the two-phase refusal read before `--force`, Uninstall still names
  its cost before it runs, and the one REMEDY the refusal names by label,
  rewriting a definition that would SIGKILL live panes, is still a card of
  its own because the confirmation points at that button.
- **There is ONE word for where you are, on both platforms** (operator's call,
  2026-09-12): "This Machine" in a title, "this machine" mid-sentence. The
  `darwin ? "this Mac"` split is gone from titles AND subtitles, and
  `screenTitle`/`subtitleFor` take no platform argument at all. The macOS feel
  this assistant is after comes from its SHAPE (one decision per full-window
  screen, fixed bar positions, screens that ask nothing never appearing), not
  from its vocabulary, and the split cost a branch, a test matrix on every
  string, and one real misreading: a label ending on "Mac" is a prefix of the
  other platform's own word and was reported as a truncated layout bug. A
  genuine platform FACT still branches: which tmux installer to name
  (`TMUX_INSTALL_CMD`), launchd versus systemd, because that is a difference
  in what the user must do, not in voice.
- **The About footer is ONE LINE** under the bottom bar. It still owns no
  strings (`node_about`, so the facts live only in
  `crates/desktop-core/src/legal.rs`), but the colophon it used to render
  competed with the one question each screen asks. It also sets
  `retryOnMount: false`: swapping screens remounts the footer, and a failed
  read of a compiled-in constant has nothing to retry for.

The rules ported from the Subshell Server console in 2026-09-08 are unchanged
by any of that:

- **The reveal lives on the row, not the bar (round two, 2026-09-22).**
  The first parity pass retired `node_open_path`, its closed
  `config-dir | data-dir | node-log` enum, its ACL entry and its ipc wrapper
  with the Service bottom bar, and the three-way pin correctly read a
  command no page invoked as surface to delete. The audit addendum the same
  day found what was wrong was the PLACEMENT: the server's Status rows carry
  an inline Reveal on each path fact, naming an intent for Rust to
  re-resolve from its own fresh probe. Round two restored the whole surface
  unchanged and moved the buttons onto Status's `config file` and `logs`
  rows: restore and grant are ONE commit, command + permission +
  capability + pin, the same atomicity rule from the other direction. A
  hint row reveals nothing: on Linux there is no file to reveal, and the
  `journalctl` sentence IS the remedy, rendered on the facts row and on the
  Service screen's offline card.
- **`node-log` resolves the node's OWN capped file first**, on every
  platform (2026-09-18): `~/.config/subshell/logs/agent.log`, the same
  JSON-lines file the plane's node log view serves, so the path the facts
  list names and the log a browser reads cannot be two different documents. That is
  the order `apps/server/desktop`'s `desktop_logs` reads the server's log in,
  for the same reason. The service manager's redirect is the FALLBACK and a
  genuinely different artifact: `~/Library/Logs/subshell.log` holds the raw
  stdout of a node that died before opening its own file (Linux has no such
  file: the unit redirects nothing, so the fallback is the journal sentence).
  A rung counts only when it has CONTENT, not merely when it exists, because
  the capped writer truncates to zero and starts over, the same rule
  `server_log_tail` follows. `node_log_paths_from` takes its two roots and a
  content predicate so the ORDER is tested without a machine in a particular
  state.
- **The Status section's Node log pane (round two, 2026-09-22).** A group
  heading over a scroll-stick `pre`, fed by the new `node_logs` command,
  ARGUMENT-LESS, like the server's `desktop_logs`: Rust locates the file
  through the same `node_paths` the probe reports (so a page can name no
  file), renders the capped JSON-lines to `HH:MM:SS level message` with
  unparseable lines kept VERBATIM, caps at the server's 200, and answers
  `{text, source, note}` where every failure is a caption the pane renders,
  never a rejection. The HOST feeds it only while Status is the shown
  section (the server host's `statusUp` rule), once on arrival and then per
  probe tick; the tick it rides is the probe query's `success` cache event,
  because structural sharing hands an unchanged machine the same data
  reference and a fast poll even the same-millisecond timestamp
  (both measured). What is deliberately NOT ported from the server's
  StatusDetails: its "Last action" pane; this app's output-ownership
  ruling already decides where an action's words render (the screen the
  press happened on), and a second always-on copy on Status would
  contradict it. That, the missing app-managed-child choice, and the switch
  gate naming 0.15.0 where the server's names its own floor, are the three
  honest places the two sections read differently, each on purpose.
- **The plane's second door.** `node_open_plane_url` opens a row in the
  SYSTEM browser, for what the in-app window is wrong for (a different
  profile, a share, passkeys). Since the plane-list ruling both opens take
  `url: String` from the page (the signature pin in `ipc-acl.test.ts` covers
  all four plane commands) and persist NOTHING: the row the person pressed
  names the address, and the persist-then-open ordering the old ladder
  required died with it.
- **tmux is a gate, not a caption.** Enroll and the service verbs that START
  things (Install, Start, Restart) are disabled while the probe cannot find
  tmux: `enroll` refuses CLI-side and a tmux-less node comes up online with
  no harnesses, so a live button only manufactures the failure. The verbs
  that cannot manufacture it stay live: Stop and Uninstall take things down,
  the run-at-login switch writes only the NEXT login, the Status rows'
  Reveals open paths whatever tmux is doing, and a disabled one of
  those strands the box. The hint names the install command
  (`TMUX_INSTALL_CMD`), and the gate reads the CURRENT probe, so installing
  tmux re-arms it.
- **The manager row says what the manager said.** `probe-facts` appends the
  service `detail` verbatim (`launchd: spawn scheduled` is the crash-throttle
  wait) and paints `state: unknown` bad; a manager that would not answer is
  not the same fact as a stopped node.
