---
"@internal/server": patch
---

Stop every reopen of a terminal from adding another stray prompt line at the top. Reattaching at the size the pane already has changes no geometry, so tmux re-wraps nothing and there is no stale frame to correct; yet the attach still probed with a SIGWINCH and a ±1-column nudge whenever nothing answered. Prompts that redraw on resize (powerlevel10k, ble.sh) answer each of those geometry events by inserting a line and repainting INTO their own history: one orphan prompt at the top per reopen, growing on every one. A same-size reopen now does exactly nothing beyond fitting the queue's view: no resize, no wait, no winch, no step. The provocation stays where it earns its keep: a resize that actually changes the grid on a pane that then refuses to repaint. (The fresh-terminal case was already fixed; this was the reopen half, and the half that kept stacking copies onto a settled terminal's scrollback.)
