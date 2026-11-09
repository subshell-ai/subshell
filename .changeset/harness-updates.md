---
"@subshell-ai/plugin-api": minor
"@internal/server": minor
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
"@internal/docs": patch
---

Harness updates become a first-class action: the node page's harness rows can run each CLI's own update line (and Update all walks them sequentially), on the control-plane host or an enrolled node. A plugin declares the line with a new optional `subshell.update` block and falls back to its installer when that is idempotent. Each subshell also records the harness version it launched on. Nothing restarts a running pane on a version change.

The node protocol moves to 28, so enrolled nodes need subshell 3.5.0; older nodes are held for their own update until they catch up.
