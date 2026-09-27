---
"@internal/server": patch
---

Reloaded terminal panels now open with the session's prior output in the
scrollback instead of a single bare screen. Apps that draw on the alternate
screen, Claude Code among them, keep no terminal history in tmux, so a reload
used to show only the current frame with nothing to scroll up to. On attach the
server now also sends a bounded window of the pane's own output log, and the
browser replays it so the panel opens the way a tab that has been open for
hours does. Set `SUBSHELL_TERMINAL_HISTORY_BYTES=0` to turn it off.
