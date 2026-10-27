---
"@internal/server": patch
"@internal/node": patch
---

A pane viewer could open already garbled, and stay garbled for its whole life: the replay's cursor read accepts a blank answer as row zero. tmux occasionally prints `":"` for a pane caught mid-redraw, and `Number("")` is 0, so that moment became a confident "the cursor is top-left", the replay ended sixteen-odd rows off the pane, and every later frame that repositions relative to it (a TUI repainting its pinned spinner block) landed on the transcript instead. The read now answers the pane's real position or nothing at all, and "nothing" takes the known degrade: a replay without the restore rather than a wrong one. The attach journal line gained the matching witness, `cursor=x,y|none`, so the next "fixed elements overlap the output" report reads the base off the log instead of guessing. Also: the hand-run attach probes were repaired (stale dist paths, and `test-setup.ts` no longer loads outside the runner, so they get their own preload) and `probe-join.ts` joins a pane the way production does, overlap and all.
