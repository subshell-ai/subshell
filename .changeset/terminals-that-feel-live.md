---
"@internal/server": patch
"@internal/node": patch
---

Pane output reaches the terminal in milliseconds instead of a second.

The tail that carries a pane's output to an attached browser used `fs.watch`
for immediacy, with a 1000ms interval behind it described as a "safety net for
missed watch events". On macOS that safety net was the whole transport:
measured on bun 1.4.2, a watch on a file appended by ANOTHER process — which is
exactly what tmux `pipe-pane` is, `sh -c 'cat >> log'` — fired 0/10 in one run
and 1/3 in another, while reporting in-process writes reliably. So every
keystroke's echo waited for the next tick: 698ms on average, with every sample
within 2ms of the rest, the signature of a fixed timer rather than an event.

That is why typing and resizing felt seconds behind: a keystroke reaches tmux
in ~5ms, but nothing carried its echo back until the poll came round.

The poll is now named for what it is and runs at 50ms, measured end to end at
6ms median / 50ms worst case through the real launcher against a real pane. It
costs one `stat` per tick per ATTACHED pane (9.4µs, so ~0.19ms of work per
second per pane) and the pump only exists while somebody is watching. The watch
stays as the optimization it always was, on the platforms that honour it.

All three copies of the mechanism are fixed — the WS attach source, the local
launcher's tail, and the node agent's, so panes on a macOS node gain the same.

The existing tests could not have caught this: they append in-process, the one
case `fs.watch` reports reliably. The new ones append from another process, as
pipe-pane does.

Opening or reattaching to a subshell is also several times faster. The fit-
then-repaint step before the replay was sized for a TUI that repaints once
and goes quiet: a pane animating a spinner (an agent thinking) never gave it
150ms of quiet, so it ran to its 1500ms deadline on every attach, and a pane
that never repaints at all (a plain shell) burned every no-growth grace in
sequence. Measured with the real functions against real panes: 1.55s and
1.18s. Two changes, both keeping the mechanism and its purpose ("improves the
first paint only; correctness lives in the gap-free join"): a same-size reopen
no longer resizes at all — tmux makes that a no-op, no SIGWINCH fires, and
the 450ms wait for a repaint that could not come is gone; and the wait after a
real resize now caps at 300ms with a 60ms quiet window that falls between an
animation's frames instead of waiting for it to stop. Same measurement after:
193ms animating, 363ms idle. Both attach paths share one helper now, so they
cannot drift.
