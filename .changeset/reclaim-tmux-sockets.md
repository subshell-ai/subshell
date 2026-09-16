---
"@internal/server": patch
---

Terminating or deleting a subshell now reclaims its tmux socket file

Every subshell owns a tmux server, and tmux does not unlink the socket when
its last session ends — so each subshell left a 0-byte file in the tmux
temp directory forever. 737 had accumulated on one developer machine, one per
subshell since the beginning, alongside ~2,000 more from test runs.

`TmuxRunner.cleanSocket` already existed and was already tested; nothing in
production had ever called it. Terminate and delete now do.

The reason it was not simply added to the shared kill helper is the reason it
took a while to be right: a **restart** kills the pane and respawns it on the
SAME socket, so reclaiming there would unlink a socket a live tmux server is
about to bind, orphaning the pane. Only the call site knows a kill is final, so
that is where it lives — and a test pins both directions, including that a
restart reclaims nothing.

Two gaps stay open and are marked in the code rather than guessed at.
Subshells on a **remote node** still accumulate a socket each: the file is on
that machine's disk, and the node cannot tell a restart's `kill` from a
terminate's without a new frame. A pane that **exits on its own** keeps its
socket until the row is deleted, which is what delete now covers.
