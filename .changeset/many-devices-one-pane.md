---
"@internal/server": minor
---

Several devices can now watch and drive one subshell at the same time, and the
UI says which device is deciding its size.

A tmux pane has one grid, so the server used to dodge the question by evicting
the older viewer: opening a subshell on a laptop closed it on the phone. It now
sizes the pane so every attached device can display all of it — the smallest
visible viewer wins, per axis — which is a pure function of the viewer set, so
the pane cannot bounce between two clients the way last-writer-wins did.

A viewer that is not being rendered drops out of that decision. A backgrounded
tab is not laid out at all, so it cannot re-fit until it is shown again, and
letting a phone left open in another tab hold every laptop's terminal at phone
size — with nothing on screen to explain it — is indistinguishable from a bug.
It rejoins the moment it is looked at.

The subshell header gains **Devices (N)**: every attached device with the grid
it can display, which one is you, and which is holding the pane where it is
("sets width", "sets height"). From there the size can be pinned to one screen
instead, and released again. Sizing is an `edit` act like typing, so a `view`
grantee sees the list but changes nothing.
