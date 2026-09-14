---
"@internal/server": patch
"@internal/node": patch
---

Typing in a terminal no longer freezes every other pane on the machine.

Every tmux command the pane path runs — a keystroke, a resize, a screen
capture, the grid readback, the title and exit-code probes — was a synchronous
child process, so for as long as it took, the whole server was stopped: no
other pane's output pump, nobody else's frames, no HTTP. On a loaded host that
was measured at 60-70 ms per keystroke, which one person typing paid and
everyone else's terminal paid with them. Those commands now run without
blocking, and keystrokes for one pane are still delivered in the order they
were sent — including the text-then-Enter pair that delivers a prompt.

The node agent gets the same treatment, so a subshell running on an enrolled
machine benefits from it too.
