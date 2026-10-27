---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

A finished agent helper now leaves the sidebar on its own. A subshell an agent opened over MCP nests as a leaf beneath its creator, and until now that leaf stayed forever unless the agent deleted it, so a helper whose pane had exited cluttered the tree indefinitely. The server's 60 s housekeeping sweep now retires a cross-agent helper about half an hour after its pane died, or once a launch left a crashed-zombie row, through the ordinary delete act (token, log, and workspace cleanup included) so its leaf drops from every open dashboard at once. A helper an agent terminated on purpose to keep its history is left in place, as is any helper whose pane is still running, so collecting results and calling `delete_subshell` remains the immediate close; the MCP tool guidance and the helper-lifecycle guide say a forgotten helper is retired on that grace rather than lingering.
