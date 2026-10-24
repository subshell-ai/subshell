---
"@internal/server": minor
"@internal/node": minor
"@internal/docs": patch
---

Add pane preview. Nodes carry an opt-in Preview switch, and workspace panes and the subshell page grow a Preview section for what a pane offers to watch. Ports the pane listens on can be opened through the server's own proxy, no new ports on the machine. A browser running inside a pane with remote debugging can be watched as live frames. A pane launched with a virtual display gets its own Xvfb screen (Linux nodes with Xvfb, x11vnc, and xauth installed), viewable live and inputtable. Unsupported machines refuse by name instead of half-serving. A screen watched over a plain http address keeps the console quiet: noVNC's TLS warning is about connections it opens itself, and here the page hands it the socket.

Preview also works on the server’s built-in node. Virtual displays check the machine’s platform and Preview setting before launch, phone app previews use a new-tab link, and viewers can use full screen without reloading the app.

Check virtual display prerequisites before launch, disable the checkbox when programs are missing, and let users recheck after installing them.
