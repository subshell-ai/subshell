---
"@internal/server": patch
---

Rolled the terminal attach path back to its last known-working state. Two fix attempts from the 2026-09-04 garble saga are reverted: the geometry reconciliation (`6351853` — the `geometry` frame, serialized/coalesced resizes, and the client's ack → re-ask → conform loop) and the quiet join (`9190c2f` — zero-overlap replay plus a CUP restoring the pane's cursor mid-screen). Each replaced a simple one-shot step with a mechanism that could keep negotiating with the pane, and the net result was worse than the state they were chasing.

Kept, because both fix defects that pre-date the rollback point and neither adds a feedback loop: the replay frame still has its trailing terminator stripped, so the client's viewport stays 1:1 with the pane's rows, and a reattached pane is still repainted with a bare SIGWINCH rather than a geometry nudge that reflows scrollback. Resizes are fire-and-forget again.
