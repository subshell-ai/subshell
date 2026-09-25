---
"@internal/server": patch
"@internal/node": patch
"@internal/docs": patch
---

Fix the fresh-terminal replay so typing lands on the visible prompt.

The attach replay ended with the client's cursor at the bottom of the grid
while the pane's cursor sat at the prompt near the top, so every live byte
(echo included) painted below the visible prompt (the "prompt at the top,
typing off-screen" report). The replay now ends with an absolute move to the
pane's real cursor: a new `pane_cursor` node command (protocol 12 → 13) feeds
it, and an older agent that cannot answer simply gets the previous behavior.
A booting pane's first frame now waits for the shell's first paint instead of
shipping the blank grid, the log file is waited for (the whole-grid poll
fallback stays for panes that never get one), and bytes already queued at a
booting viewer are dropped rather than replayed on top of the capture, which
double-painted prompt sequences into ghost prompts.
