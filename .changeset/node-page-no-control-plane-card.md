---
"@internal/server": patch
---

The node page no longer shows a "Control plane" card. The server cannot see which address a node dials, so its one field could only ever stand blank next to a sentence admitting that; moving a machine stays with the surfaces that actually know it: `subshell configure --server` on the machine, and the node's own local dashboard, which can name the current address because the config file is in its hands.
