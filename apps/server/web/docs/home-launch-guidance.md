# The home page, and what may launch

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**The home page reads its state as a dot and segments by machine** (operator
calls, 2026-09-24). The cards' corner chip and the list's STATUS column are
gone; both draw `SubshellDot` beside the title instead, `accessible` because
there it is the ONLY thing carrying the state word (the rail keeps its dot
`aria-hidden`; its row text already speaks). Two colour calls, both
2026-09-24: offline is the dot's RED (`bg-destructive`, a reversal of the
orange it launched with; a machine you cannot reach is an error, not a
caution), and idle is DIM GREEN (`bg-success/50`, not gray: green is the
ALIVE family; gray may now only mean not-running). The printing dot BLINKS,
a hard on/off square wave (`subshell-dot-blink`, defined in `styles.css`
beside the motion gate; the operator's "like Claude Code's in-progress
work", first built as a halo pulse and deliberately replaced): the alive
pair now differs by motion as well as brightness, the loop being honest
only because the dot's DOM node never remounts (stable keys plus the
feed's structural sharing), and under `prefers-reduced-motion` the class
carries nothing, so the dot is plainly green. The bell never blinks. The tiles are segmented on the group-by axis (By machine | By status | No grouping selector, machine default; operator ask 2026-09-24), and BOTH views segment on the SAME `SubshellSection`s: tiles get headings, the list gets a band row per section (`lib/subshell-sections.ts`, banding on the shared indicator, never a second status model). Machine sections ride the RAIL's own machinery (`sortByStatus` into
`groupSubshellsByNode`/`nodeLabelFor`) with no per-group cap and no collapse
(a grid of cards is not a rail), and the old Running/Paused/Completed bands
left with the chips, and the group-by selector can band by status again, on the dots'
own indicator precedence, never a second status model `nodePill` left the card
with the corner chip, so the section header is the one place a tile says which
machine it is on. The toolbar is two deliberate rows (operator ask 2026-09-24): search full-width on top; machine combobox (`flex-1`), group-by select, and the view toggle share the row under it. A searchable machine combobox (`SearchableSelect`) narrows BOTH views
(default **All**); three rules ride it: its options are the machines with rows
(`machineIds`, never an option that answers nothing), a stale selection is
kept in the list so the control never blanks itself out from under its own
value, and it is ALWAYS drawn (operator ruling 2026-09-24, deleting the
`showMachineFilter` gate that hid it until a second machine had rows; on a
Server-only instance the control read as the feature being missing).
**The Server can stop being a launch target** (2026-09-24): `allow_server_subshells`
(Settings → General, the Nodes card's second switch; absent row = ON; audited
`settings.update`) refuses EVERY new launch and restart on the host, admins
included, but non-destructively: running panes finish, the `local` row stays
visible and manageable (deliberately not maintenance, which kills panes and
says so). The gate is `nodeCanLaunchOn`'s fifth input server-side, so
`canLaunch`, the pickers and the create/restart refusals all follow one
reading; the refusal's message names SETTINGS, never shares, because the
remedy is a different control. On this page the decision of what to show when
NOTHING can launch (Server off AND zero agent rows, nodes read ANSWERED)
lives in `lib/launch-guidance.ts`: an add-a-machine card for a viewer who may
mint keys, an ask-an-admin card for one who may not, the button real on both
branches; every other empty case keeps the ordinary "No subshells yet" card.
**Lockdown mode is the instance-wide stop** (2026-09-24 operator ask): a
`lockdown` settings row (absent = OFF; audited `settings.update` whose
metadata carries the stopped ids). ON stops every running subshell everywhere
and 403s every create and restart before any machine is chosen; it is NOT
maintenance worn as a hat (that is one machine, its owner, mirrored onto the
box; the node view keeps `canLaunch: true` during lockdown because refusing
everything is the BANNER's story, not a lie about one row). Turning it ON is
typed: the PATCH must carry `lockdownConfirm` equal to the admin read's
`localNodeName`, the dialog's button lights only on that equality (operator
ruling 2026-09-24), and the server re-checks live for the rename-mid-dialog
race. BOTH directions are typed with the same name (a way out is as instance-wide an
act as the way in, operator ruling 2026-09-24; only the dialog's words
differ), and ending restarts nothing. A re-submitted ON is INERT (the echo
neither asks nor acts), so the retry path for a row an ON reported in
`failed[]` is ending and re-starting the lockdown, or terminating that row
directly: no press-again retry (operator ruling 2026-09-24).
Everyone signed-in learns the state from the shared public read:
`components/lockdown-banner.tsx` is a non-dismissible amber alert mounted in
`__root` (absent field = a server older than the feature = no banner, and the
General page's `LockdownCard` does not render at all without its two fields).
