# Enrollment: the Add-node dialog, key setup, setup keys

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**Whether "Add node" is offered is `lib/node-enrollment.ts`, not an expression
at each call site.** Two surfaces ask (the Nodes page and the launch picker's
empty state), and both mirror `POST /api/nodes/setup-keys`'s own gate
(`allow_node_enrollment`, admins exempt) so neither offers a button the route
refuses. The half a second copy gets wrong is the UNKNOWN one: an unanswered
settings read counts as ALLOWED, matching the server's absent-row default,
because reading `undefined` as "off" hides the control from everyone on every
load until the request lands. The argument is `Partial<>` for the same reason:
a payload from a server older than the setting carries no such field. The
button is ALWAYS DRAWN, disabled where it does not apply (operator ruling
2026-09-24, reversing the earlier hidden-not-disabled choice: a hidden button
makes the feature itself look missing). `NODE_ENROLLMENT_OFF_COPY` is the
single source of the why, and it reaches people on three carriers: the dead
button's tooltip (hover: the trigger SPAN holds the tab stop and
`aria-describedby`, since a disabled button cannot be focused and Base UI
wires nothing itself), the SAME sentence as the empty state's visible
description (a touch viewer cannot hover, and review round 2026-09-24 refused
hover-or-nothing), and the launch form's empty card. What was deleted is the
PERMANENT paragraph above the list, not the explanation.

The Nodes UI (`routes/nodes.tsx`, `routes/nodes_.$id.tsx`, components grouped in
`components/nodes/`, data in `hooks/use-nodes.ts` + `use-node-shares.ts`): the
**Add-node dialog is ONE screen** (operator's call, 2026-09-18) titled
**"Install Subshell client"**: the trigger button stays "Add node", but opening it
lands on the instructions; the old first screen, whose whole content was one
button, is gone. Its address dropdown is labelled **"Select Subshell server
address"**, and it **names what the node dials forever** (operator's call,
2026-09-18), not merely the curl's host, and it sits ABOVE the mint press and the
Terminal / Desktop App switch rather than inside the terminal panel, because both
paths need the same address: the script bakes it, and the app's Connect step is
typed this same URL. Between it and the switch sits the **Generate setup key**
button: until it is pressed NO KEY EXISTS, and the screen says so instead of showing
a hole: the app path's key row reads "Generate setup key first" where the copy row
will be, and the terminal one-liner is on screen from the start with
`<generate setup key first>` in its token slot and COPY DISABLED (the panel being
never empty is the operator's call; a copied placeholder would run nowhere, so only
the mint makes the command real). The address row IS copyable
from the start; it needs no key. Rows come
from the same `lib/install-addresses.ts` the mobile picker builds: the
trusted-origin allowlist, loopback dropped when anything else is known,
falling back to `appBaseUrl` alone when nothing is (`window.location.origin`
only while settings load). The chosen address rides to `GET /install.sh` as
`server=`, which the route bakes **only on exact membership in the live
registry** (`api/install-script.ts`), because the process cannot observe its
own external address (a TLS proxy shows it loopback, the `Host` header is
client-written, and several names are simultaneously true), so the operator's
choice has to arrive written down, like NetBird's `--management-url` and the
dialog's own `subshell setup --server`. `&server=` is carried ONLY when the
pick deviates from `APP_BASE_URL`, so the stock command is byte-identical to
the one this predates. The amber "APP_BASE_URL points at loopback… replace
the host" paragraph is GONE (operator's call, 2026-09-18): its advice could
not work (hand-editing the curl host changed only the download source, while
the baked `SERVER` came from config), and the dropdown replaced the whole
sentence with the control it was telling you to build by hand. The script's
runtime loopback guard stays: it fires on the new machine, where "is this
address wrong *from here*" is finally knowable. The dialog also reads `nodeArtifactTargets` (the
triples the server actually serves) and names the missing ones IN THE TERMINAL PANEL
(both the refusal and the copyable `subshell setup` fallback it drives live beside the
command they describe, not in the generate slot above; `setup`, not `enroll`, because
`enroll` requires `--name` and a person reading a command off a browser should be
ASKED for the name instead): a binary-only server install publishes no node
binaries until `release:cli-node` runs, and the one-liner 404s on every machine
until then. The field being ABSENT (older server behind a cached PWA) stays
silent; the query still loading or errored shows a "could not check" line
instead: no verdict without data. Opening the dialog refetches so a just-
published artifact set is visible at once. The **Desktop App** panel sees NONE of
this, and that is the point of that path: the app ships its own node binary, so what
this server has or has not published is nobody's problem on that machine. The amber
refusal DOES name the app as the third door while the operator is still choosing.
**The dialog asks no name, and the invariant about the key moved.** Its first
screen used to be a "Node name" field whose text became only the setup key's
`label`: the one-liner never passed it on, so the node was named by its own
hostname whatever was typed. With the 2026-09-17 revamp the field is gone, the mint
takes no body, and the name is asked on the machine (`subshell setup`'s first
question, `--name` for a script, Subshell Client's required Enroll field).

What each panel shows is now the SHORTEST true version of itself, because the
explanatory prose was cut on 2026-09-18 (operator's call): the terminal panel had a
paragraph walking through what the script does ("installs the node CLI to
`~/.local/bin`, asks what to call this machine, enrolls it, and then asks about the
background service…") and the app panel had one walking through opening the app
("In Subshell Client, open Window → This machine…"). **Both are gone**: the command
and the two labelled value rows ARE the instruction, and the script narrates itself on
the machine it runs on. `add-node-dialog.test.tsx` asserts each absence, so neither
regrows as a well-meant restoration. So: **on the terminal panel the key lives inside
a command and never outside one** (one row in the common shape, two (curl and the
`setup` fallback, alternatives that each carry it) on the air-gapped branch), while
the app panel shows the two VALUES its Enroll step takes, address and key, each with
its own copy button that `label`s what it copies. The standalone key box, its "shown
once" subtitle and the tmux paragraph stay gone too, and so, same day, does the
first-run-per-platform sentence (operator's call, 2026-09-18): NOTHING sits between
the address picker and the Generate button but its own failure line. One sentence of
guidance survives, and it sits where it can change what the operator does: the amber
no-binary refusal, INSIDE the terminal panel beside the command it refuses (the
verdict is about the command, and the command is on screen from the start; its key
slot holds `<generate setup key first>` and copy is DISABLED until the mint, since
the shape is the instruction but a copied placeholder would run nowhere). The same
verdict drives the `setup` fallback row two lines below it.

**The fields are their own component**, `components/nodes/node-key-setup.tsx`
(`NodeKeySetup`, plus `installCommandFor` / `setupCommandFor` / `useSetupKeyVerdict`),
because a second surface needs it: the address picker, the `Terminal | Desktop App`
switch and both panels are a function of a key (which may be `null`, the not-yet-
minted state above) and of public settings, not of a key that was minted thirty
seconds ago. The mint itself is an OPTIONAL `generate` slot between the picker and the
switch: the dialog passes the button and its failure line (the two verdicts live
inside `NodeKeySetup`'s own terminal panel, not the slot); the card
passes nothing. `AddNodeDialog` therefore keeps only the mint press and the enrollment
watcher, and `SetupKeysSection` renders the same fields for a key minted earlier.

`components/nodes/setup-keys-section.tsx` is that card, and it is the reason the
server can show a key after the mint: `GET /api/nodes/setup-keys` returns each of the
caller's own rows WITH its key text (owner-scoped, cookie-only; a bearer credential
cannot enumerate enrollment doors). The row's title is the key, with
`CopyableValue`'s copy affordance, because the label that used to title it named
nothing a person could match to a machine. `keyState` still decides
unused / used / expired from `usedAt` and `expiresAt`, which is what keeps the
disclosure honest: a spent or stale row's key is inert, and the badge says so.

The row also carries **`Setup`, on the `unused` rows only**: the card hands back the
COMMAND as well as the key. That was the remaining half of the defect: closing the
dialog mid-copy lost the one-liner, and the only way to re-read instructions that had
never actually been lost was to mint a SECOND single-use key. The button opens
`KeySetupDialog`, which is `NodeKeySetup` in a dialog with a Done button and nothing
else. A used or expired row gets no such button by design: its key is inert, and
walking someone to a 401 they cannot act on is not an instruction.
