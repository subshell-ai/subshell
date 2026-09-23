---
"@internal/node": minor
"@internal/desktop-client": minor
---

Subshell Client's Service section now offers what Subshell Server's does,
adapted to a node: the background arrangement stated in one card, a
run-at-login switch under it, the lifecycle verbs (Start when the node is
down; Stop, Restart and Uninstall when it is up), and an
install-and-start door for a machine whose node CLI is installed but has no
service keeping it running. The switch is greyed with the exact update
sentence on an agent older than this release, because only 0.15.0 gained the
verb to write the answer with. On both the Status and Service screens the
state chip now reads in the screen header, between the title and the
subtitle.

Status grew the two halves of Subshell Server's Status section it was
missing: the path facts carry their own inline Reveal button (the Service
bar's two buttons moved onto the rows whose value is the path, each opening
only the fact it is already showing), and a Node log pane tails the agent's
own log while the section is open.

Behind the switch, the node CLI gains `subshell service autostart on|off`:
it arms or disarms login start for an installed service and touches nothing
that is running. `subshell service status --json` answers the same fact
under its own name, `autostart`, so an older agent without the field still
probes (the switch reads `enabled` there). The copy names no service managers. The named thing is the Subshell Node
Service, the card states the CURRENT condition ("Currently the Subshell Node
Service runs in the background, but does not automatically start on
startup."), and the "Start automatically on startup" switch carries help that
says what flipping it changes, in each of its states.
