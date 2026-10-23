---
"@internal/server": minor
"@internal/node": minor
---

Add pane preview. Nodes carry an opt-in Preview switch, and the subshell page grows a Preview section for what a pane offers to watch. Ports the pane listens on can be opened through the server's own proxy, no new ports on the machine. A browser running inside a pane with remote debugging can be watched as live frames. A pane launched with a virtual display gets its own Xvfb screen (Linux nodes with Xvfb, x11vnc, and xauth installed), viewable live and inputtable. Unsupported machines refuse by name instead of half-serving.
