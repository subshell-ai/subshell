---
"@internal/server": minor
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
"@internal/docs": patch
---

Harness rows on an enrolled node now offer Install, for the node's owner or a Manage grantee. It runs the built-in plugin's own installer on that machine, under the same ten-minute bounded runner as the local installer, and reports the result on the row. The node protocol moves to 29, so enrolled nodes need subshell 3.6.0; older nodes are held for their own update until they catch up. Third-party plugin install commands remain copy-only guidance.

The Workspace section's empty state now lines up with the subshells empty state.
