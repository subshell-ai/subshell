# Service and supervision: two cards, three axes

Deep dive for `apps/server/web`, moved verbatim out of `AGENTS.md`.
This file carries the full history behind the summary; the routing line in
`AGENTS.md` names when to read it.

**Two cards, because they are two kinds of thing.** `ServiceCard` is about the
running PROCESS: who supervises it, since when, and Restart. `SupervisionCard`
is about the MACHINE: whether anything brings this server back by itself. In
the desktop app that is a choice: which of the two modes it is in, and, below
both, a settings pane's own shape, whether it starts at login. That switch is genuinely
dependent on the background mode (the route 409s under the app, and there is no
definition to arm), but the dependency is carried by a disabled reason naming
the other mechanism, not by nesting: indenting it under the first radio wedged a
control between the two choices so they stopped reading as a pair. They were one card, and it read wrong:
"Restart server" and "change what supervises this machine from now on" sat as
sibling buttons, the second a bare "Run with the app instead…" that named no
alternative and explained nothing.

**`SupervisionCard` is two cards wearing one name, and `isServerDesktop()` is
the seam.** Inside Subshell Server it is a CHOICE: both modes, current one
marked, and the login switch. In a browser it is a FACT and at most one fix.
It used to show the choice everywhere, disabled, which was wrong in both
directions on the machine that matters most: a headless Linux host was offered
"With the Subshell Server app" under a line telling you to change it in an app
that machine does not have, and the control beneath ("Start at login") asked
a question a server does not have. That label reads as a desktop session, so an
operator who wants no GUI switches it off and loses the server at the next
reboot.

**In the app: the radio IS the choice, and the confirmation is a dialog on this
page.** Clicking the unselected mode opens `SupervisionDialog`, which lists what
the switch does and calls `desktop_set_supervision` through the desktop bridge
(`useSetSupervision`), no assistant window (operator's call, 2026-09-12;
`docs/security.md` carries the accounting for granting that command to the
SPA window). The radio shows the MACHINE, not the pick (it does not move until
the machine reports the change), so dismissing the dialog cannot leave the
card claiming a mode that never took effect.

**In a browser: `persistence()` answers the one question a person not sitting
at that machine actually has**: will this still be running after a reboot, or
after I log out? One sentence, then a remedy only where the answer is
unsatisfying: the `loginctl enable-linger $USER` command, a **Start
automatically** button (`POST /api/admin/server/autostart`, the `true`
direction only), or the install command. No radios, no dialog, no switch, and
no line telling you to go and find an app.

The off direction is deliberately absent rather than merely unimplemented: a
browser reader is not at that machine, disarming a service strands it at the
next reboot, and nobody sets out to have a unit that runs now and vanishes
later. It stays a CLI act (`subshell-server service disable`).

**The command returning is NOT the switch being done, and that gap needs a
state of its own.** `desktop_set_supervision` answers once the new server is
STARTING; the card cannot move until that server answers. So `useSetSupervision`
has a second phase, `settling`, which polls `GET /api/admin/server` directly
until `currentMode` reports the mode that was asked for, then WRITES the view
it already holds into the cache (invalidating alone costs another round trip on
the exact sentence that is the confirmation). The card renders a spinner and
"Switching to …, waiting for the server to come back", and locks both radios
while it runs; a 60 s cap turns into "The server has not come back." Without
this the dialog closed onto a card still showing the old mode with nothing on
screen saying why, and it read as a page that had ignored the click.
`ServiceCard`'s restart line carries the same spinner, for the same reason.

**The model is `lib/supervision.ts`, not the card.** `SupervisionMode`,
`currentMode`, `loginDisabledReason` and `modeLabel` live there because the
HOOK needs `currentMode` to know when the switch has landed, and importing it
from the component would make a real value-level cycle. `currentMode` answers
`null` for a server nobody supervises (started by hand, a container, the e2e
stack), rather than defaulting to the background mode, which put "A launchd
agent runs it" directly under `ServiceCard`'s "Running, not supervised".

`persistence()` lives there too, and is shared with a card on a different page:
a node's Runtime card asks the identical question about a machine that is
never the one serving this page, so the two answer it in one voice. It returns
a sentence plus a `PersistenceFix` discriminated union and NOT the remedy's
copy, because what "install it" looks like differs per surface (the server
page copies a command, a node page points at the Install service button below
it (the Runtime card renders first)), and a model that shipped the words
would be answering a question it
cannot see. `machine` is a parameter for the same reason: "this machine" on
the Service page, the node's own name on a node's.

**The mode and the login switch are two axes, and the in-app copy has to keep
them apart.** The radio answers WHO runs the server; the switch answers whether
it comes back BY ITSELF next time you log in. Both managers run the server
inside the user's own login session, so it stops at logout either way, which
is why "keeps it running whether or not the app is open" was misread as
covering logins and now reads "runs it, whether or not Subshell Server is
open", with the switch saying what it adds ("nothing brings it back after you
log out or restart"). The desktop assistant's two screens carry the same
distinction.

**On Linux there is a THIRD axis, and it is the one that strands headless
servers.** A `systemd --user` unit runs inside its owner's login session, so an
ENABLED unit still dies at logout unless the account lingers
(`loginctl enable-linger`); with lingering it comes back at boot with nobody
logged in. So "starts at login" and "survives a reboot" are different facts,
and on a box nobody logs in to the first one is worth nothing. The node and
the server both measure it now (`service.linger`, `null` on macOS where a
LaunchAgent's lifetime IS the login session and no such knob is missing), which
is what lets the browser state which machine you have instead of explaining
both cases at everyone. The in-app radios are unchanged by this, and that is a
DECISION rather than an oversight: the Subshell Server app is the one surface
that measures `linger` and does not show it. Someone sitting at that machine
logs in to it by definition, which answers the reboot half; it does NOT
answer the logout half, and on Linux that half is real even there. What makes
it tolerable is that this surface never claimed otherwise: it offers a choice
about who runs the server, not a promise about how long it lasts. Revisit it
if the app ever ships for a machine its owner does not sit at.

**The act cannot be a route, and the reason is specific rather than the usual
one.** Switching needs an actor that outlives the server: going to app mode
uninstalls the service (stopping the server) and the desktop app is what must
then start it; going back means installing a service while the process holding
the port IS this page's server. So the card carries the choice and the
desktop app carries the act, reached over the webview's IPC, which survives
the server going away, unlike anything the server serves.

Start-at-login itself IS a route (`POST /api/admin/server/autostart`) because
it changes nothing about the running process. `loginDisabledReason` mirrors
that route's three 409s (nothing installed, the app running this server, a
manager that would not say) as a pure export, so the UI never offers what the
server will refuse.
