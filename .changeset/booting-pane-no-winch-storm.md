---
"@internal/server": patch
---

Stop fresh terminal panes from growing a duplicate prompt at the top of an empty screen. Attaching to a pane fits it to the viewer's grid and, when nothing repaints, forces a repaint with a SIGWINCH and a ±1-column nudge — right for a settled TUI holding a possibly-stale frame, wrong for a shell still booting: slow-init prompts (ble.sh, powerlevel10k) redraw on every SIGWINCH, and mid-boot redraws land as extra prompt lines written into the pane's OWN history — every viewer of the fresh terminal then sees the real prompt at the bottom and stray copies at the top. The attach now recognizes a pane that has produced zero log bytes since launch: it still gets the one fit resize (before any frame exists, so the shell boots at the viewer's geometry), and then exactly nothing else — no wait, no winch, no nudge. Panes with output keep today's dance untouched.
