---
"@internal/node": minor
"@internal/desktop-client": minor
---

The Subshell Client's Control Plane section is now a LIST of control planes
to connect to, not one address tied to the node: add an address, open a row
in the dashboard or the system browser, copy its URL, remove one — and the
address this machine's node reports to sits pinned at the top badged "this
node", not removable here because detaching a machine is the Service
section's act, not this list's. The section is a bare table with the add on
the bottom bar, and every confirmation in the app — removing a row,
uninstalling the service, un-enrolling, replacing the node CLI, spending a
setup key — now answers in a dialog instead of a panel grown inside the
section it belongs to.

Service gained the node's own binding acts in an "Enrolled to Control Plane"
card: Re-enroll… opens the enrollment wizard, seeded with the current
address, so re-binding the machine is the same walk as binding it the first
time — and its two-phase confirmation is what guards overwriting a live
configuration; and Un-enroll… stops the service, removes its definition and
deletes the node's configuration and key. Running subshells keep running, and
the card says so before it asks; the control plane keeps its node row until
its owner deletes it there. A press now owns its wait: the button keeps its
spinner and the state chip reads "Restarting…" until the node is confirmed
back up, or the thirty-second window says it is not, and the momentary
problem notes stay quiet while the machine is coming back from a press. What
remains after that is said as a warning; a step that went fine leaves no
receipt line.

The node CLI gains `subshell unenroll [--yes] [--json]` for the same act
from the terminal. It deletes only the daemon lock and the configuration —
the data directory, the installed binary and every live pane stay — and it
refuses a running daemon or running subshells, listing them, unless --yes.
