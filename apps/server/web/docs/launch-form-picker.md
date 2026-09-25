# The launch form, the folder picker, and no-launch states

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**A directory is a claim about ONE machine** (2026-09-20, operator report):
changing the launch form's Machine clears `workingDir` and re-arms the
per-machine seed (that node's most-recent path, else its home), because the
carried-over path was another filesystem's answer; the picker used to open
on it and make the person wait out a remote 404 before "Start over". This is
the Agent-resets-Preset rule one axis over; a caller-supplied node+path pair
(the clone dialog) survives, since the clear rides a CHANGE, not a mount.
`node-9`-keyed recents queries mean a switch needs no staleness gate: until
the new node answers there is no data to fill from.

**The folder picker is machine-scoped end to end** (migration 0034):
`explore`'s Recent/Favorites sections, the star mutation and the stored rows
all carry the browsed machine: walking node X shows X's shortcuts and
starring there stars X's path. Favorites used to be a control-plane-only
concept and the remote panel HID the star, because a node path starred into
an unscoped table became a dead click in every later local panel; scoping
beat hiding. A machine change re-anchors an open panel to home (`~`: the
route expands it locally, the remote service maps it to the AGENT's home).
`/recent` answers the node's rules in BOTH halves: recents filtered,
and `home` nulled when it sits where this caller cannot launch, so the
seed can never be a directory that 403s at launch. The favorite PATCH
omits `node` for the control plane, so the local wire stays
byte-identical; a node star is 404'd for invisible nodes (the no-oracle
rule `/recent` and `/explore` apply) and 400'd for relative paths: the
plane never resolves a node path against this host's filesystem.

**The launch form asks nothing it cannot answer.** `new-subshell-form.tsx`
filters its node options on the server's own `canLaunch` (never a re-derived
rule), hides the Machine field when the sole target is the control-plane host (a single AGENT node keeps it, because once a second machine exists the answer
is news), and replaces itself with `no-launch-targets.tsx` when nothing is
SELECTABLE. Three pure exports carry it (`isSelectable`, `launchableNodes`,
`hideMachineField`), tested without opening a dropdown.

**Two kinds of unlaunchable, and they are shown differently on purpose** (spec
2026-09-14). A host narrowed by its shares VANISHES: "the machine you were
never granted" is not a choice, and one sentence in the empty state beats the
same sentence on every row. A node in **maintenance** is KEPT and greyed,
labelled ` (maintenance)` as the label's last segment the way `(offline)`
already is: it is a choice with a reason and a way back, and hiding it leaves
a person hunting for a node that simply disappeared. The sole-host-in-
maintenance case belongs to the EMPTY STATE, not to the field: the form returns
`NoLaunchTargets` whenever nothing is selectable, so it never renders with one
greyed row. `hideMachineField` still requires its sole row to be selectable (zero answers is not one), but as a belt against a caller that skips that gate,
not as the thing that puts a reason on screen.

`no-launch-targets.tsx` therefore takes the node LIST, not `local` alone, and
answers per machine: what is in the way (maintenance first, even on a machine
that is also offline: waking it would change nothing), and for a viewer who
cannot move it, who can. Every route out goes through `leaveFor`, which closes
the containing dialog before navigating; `QuickAddProvider` mounts these
dialogs above the route, so a button that only navigates changes the page
underneath a modal still showing this same empty state. Ending a maintenance
window navigates to the node's page rather than PUTting from here: it re-opens
the machine to everyone it is shared with, so it belongs beside the card that
says what maintenance means and which end declared it. The other unlaunchable
kind gets a different offer for a different remedy: a host nobody is granted
launch access on is fixed by a SHARE, so the button says so and lands on the
page whose header opens the sharing dialog. It used to read "Enable on {name}"
and point at `LocalLaunchCard`, which is gone: an offer that ends nowhere is
worse than no offer, and it ended nowhere for the one person who could take it.

**The form asks Agent → Preset → Node → Working directory** (spec
2026-09-13, presets replace profiles; `#picker-agent` / `#picker-preset` are
the e2e handles, `lib/subshell-compat.ts` holds the pure rules). The form is three files since the
2026-09-25 split: `new-subshell-form.tsx` is the fields and their pairing,
`launch-form-rules.ts` the pure contract (the value, the empty baseline,
`canSubmit`, the node-pick rules, the field-id sets), and
`use-launch-form-defaults.ts` the ONE defaults effect and the picker's
explicit apply. The Agent
select offers the whole `GET /api/plugins` set, greyed never hidden, and its
default (`defaultAgentId`) is the agent of the user's most recent subshell when
usable (evaluated only after the subshells LIST has ANSWERED, so an
unanswered read cannot outvote the recent one), else the first usable
non-terminal agent, else anything usable; `useSubshellsList()` already holds
the data, so the rule costs no request. Preset lists only the chosen agent's
presets with **None** first and selected; changing the agent resets it to None,
and its `+` opens `create-preset-dialog.tsx` nested in the launch dialog with
the agent locked; a created preset is selected on return. First run hides the
Preset row entirely: a new account has zero presets, so the row would offer
only "None". The saved set lives at `/presets`, grouped by agent under real
`<h2>` headers. There the row menu's **Clone preset** opens the SAME
`create-preset-dialog.tsx`, seeded through `initialForm`: the clone IS a plain
create, and the agent rides locked because a preset's harness is immutable.
The suggested `… (2)` name mirrors the UNIQUE index's collision rule, so the
prefill is a name the server can accept. A presetless launch omits `presetId`:
absence, never null.

**The launch dialog opens on your last launch** (operator ask 2026-09-25):
the form's node and directory pre-fill from the newest prior subshell, and a
**Copy settings from** row above the Agent (`#picker-copy`) applies any listed
row's four settings as an explicit act. Two arms, one selector:
`launchTemplateFromList` (`lib/launch-defaults.ts`) reads the SAME
`sortByCreation` head as `defaultAgentId`'s recent tier, so the agent default
and the full-settings default can never disagree about which row is "recent";
the agent and its preset ride the existing blank-only tier, which consumes the
armed template and applies the preset only when ITS agent survived the
usability check. The auto arm fires once, only while the form still holds
`emptyNewSubshellForm()`. A Split `initialForm`, a caller seed, pre-settle
typing, or `firstRun` (whose Preset row is hidden, so a preset landed there
would be invisible) all disqualify it; the picker applies over any edit,
cancels the armed auto tier, and its row RESETS to the placeholder (the copy
is an action, not a held value the re-pickable fields would contradict).
Degradation is never a second rule: copying from an offline node re-homes the
pick and the existing machine-switch arm clears the copied directory and
re-arms the per-node seed; the preset-membership guard drops a preset that
does not belong to the landed agent. And nothing guesses at an unanswered
list: the recents seed WAITS for the subshells list to have answered (a cold
load where `/recent` lands first would otherwise have the seed mark the form
touched and disqualify the copy tier for the whole session), so on a final
list error with the dialog open the directory stays cold until the list next
answers. The same gate-the-answered-not-the-value rule as the agent tier
applies, and it self-heals on reopen, feed event, or retry. The picker lists up to 10 newest rows
(`COPY_SETTINGS_LIMIT`), NEVER disables one, and carries `agent · node · dir`
as the detail line (short node id for an unresolved machine). No new
persistence: everything rides `GET /api/subshells`, so a deleted subshell
leaves the list exactly as the agent default already ignored it. Mobile's New
screen does NOT mirror this tier (operator scope call: web only;
`agent-default.ts` keeps its "change one, change both" for the AGENT rule
only).
