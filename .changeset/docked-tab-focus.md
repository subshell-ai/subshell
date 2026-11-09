---
"@internal/server": patch
---

A mouse or pen click on a workspace tab now hands the keyboard back to that pane's terminal, so the next Esc or keystroke reaches the agent. Before this, clicking a tab left focus on the tab itself: a docked `/mcp list` report stayed open while the turn streamed above it, and typing went nowhere.

Names mirrored from a pane's title also drop omp's `π` brand and run-state separator, so a session reads `🚌 Fix the stuck overlay` instead of `π ⠋ 🚌 Fix the stuck overlay` in the rail, the pane header and the subshell page.
