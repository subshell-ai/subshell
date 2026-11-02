---
"@internal/server": minor
"@internal/node": patch
"@internal/docs": patch
---

The subshell MCP is now switchable. Two new controls, both on by default, stop Subshell from wiring it into panes: a **Subshell MCP** card in your Preferences controls your own account, and one on each node's overview page controls that machine. Either one off wins, and the node's refusal is enforced on the machine itself, so a harness that registered the MCP command directly stops with a clear notice rather than serving the tools.

Turning a switch off changes new launches and restarts; running panes keep their live MCP until you restart them. A pane launched with the switch off also loses the reach the tools carried: its credential is minted reporting-only, so it can say when its turn ended but cannot see or touch any other subshell. Its attention bell, exit status, and session reporting still work.
