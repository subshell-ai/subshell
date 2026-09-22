---
"@internal/node": minor
"@internal/desktop-client": minor
---

The Subshell Client's Control Plane section is now a LIST of control planes
to connect to, not one address tied to the node: add an address, open a row
in the dashboard or the system browser, remove one — and the address this
machine's node reports to sits pinned at the top badged "this node", not
removable here because detaching a machine is the Service section's act, not
this list's. The section is a bare table with the add on the bottom bar.

Service gained the node's own binding acts in an "Enrolled to Control Plane"
card: Re-enroll… repoints the node to a new address keeping its identity and
spending no setup key, and Un-enroll… stops the service, removes its
definition and deletes the node's configuration and key. Running subshells
keep running, and the card says so before it asks; the control plane keeps
its node row until its owner deletes it there.

The node CLI gains `subshell unenroll [--yes] [--json]` for the same act
from the terminal. It deletes only the daemon lock and the configuration —
the data directory, the installed binary and every live pane stay — and it
refuses a running daemon or running subshells, listing them, unless --yes.
