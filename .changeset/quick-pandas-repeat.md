---
"@internal/server": patch
"@internal/node": patch
---

Typing in a terminal no longer freezes every other pane on the machine.

Every tmux command the pane path runs — a keystroke, a resize, a screen
capture, the grid readback, the liveness, title and exit-code probes — was a
synchronous child process, so for as long as it took, the whole server was
stopped: no other pane's output pump, nobody else's frames, no HTTP. On a
loaded host that was measured at 60-70 ms per keystroke, which one person
typing paid and everyone else's terminal paid with them. Those commands now run
without blocking, on both the control-plane host and the node agent, and a tmux
that stops answering now fails the keystroke after fifteen seconds instead of
leaving that pane's keyboard silently dead.

Keystrokes for one pane still reach tmux in the order they were sent —
including the text-then-Enter pair that delivers a prompt — on the
control-plane host and on a node alike.

Separately, on a node: a burst of frames arriving together (a paste, or fast
typing) could be verified out of order, which the agent read as a replay attack
and answered by dropping its connection — taking every subshell on that machine
offline until it reconnected. Frames are now handled strictly in arrival order.
