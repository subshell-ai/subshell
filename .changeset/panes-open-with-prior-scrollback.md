---
"@internal/server": patch
---

Reloaded terminal panels in the web and desktop apps now open with the
session's prior output in the scrollback instead of a single bare screen.
Apps that draw on the alternate screen, Claude Code among them, keep no
terminal history in tmux, so a reload used to show only the current frame
with nothing to scroll up to. On attach the server now also sends a bounded
window of the pane's own output log, and the panel replays it so it opens
the way a tab that has been open for hours does. Mobile panels are not
reached by this yet. Set `SUBSHELL_TERMINAL_HISTORY_BYTES=0` to turn it off.
