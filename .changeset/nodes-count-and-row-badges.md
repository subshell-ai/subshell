---
"@internal/server": patch
---

Two Nodes fixes.

Server Settings → Status now counts the control-plane host among the online nodes. "Online" was the live agent-socket registry alone, which the server's own launch target can never appear in because it runs no agent — so an instance whose only node is the server read "0 online · 1 enrolled" forever, beside a Nodes page showing that same machine online.

A node row no longer crushes its name. On a node with several detected harnesses the badges pushed the name column down to about one character, rendering a letter per line under an ellipsis. The name now keeps a minimum width, and the harness chips are what give way: three show inline and the rest sit behind a "+N more" button that expands them in place. The OS, status, "inventory stale" and ownership badges are always visible.
