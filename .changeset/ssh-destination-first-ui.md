---
"@internal/server": minor
"@internal/server-web": minor
---

The Connect page: one question first - where do you want to work? Pick a
destination from your remembered hosts, your recent ones, or the connecting
machine's SSH config aliases, or type any host; one button opens the pane.
The connecting machine defaults to your chosen one, machines whose SSH is off
stay named with the remedy rather than silently skipped, and a config that
needs settings Subshell does not run shows which ones blocked. SSH-terminal
panes now read as view-only to everyone but their owner everywhere the pane
is shown (the server's view says so, so the terminal is honestly read-only),
and the pane's header labels itself SSH and tells a viewer why typing is off.

Milestone 1 of the SSH-anywhere design is complete with this: an operator on
an enabled machine opens an interactive session at any sshd-only host, and no
private key or plaintext challenge ever crosses the plane.
