---
"@internal/server": minor
---

The new-subshell form stops asking where to run when there is only one answer: on an instance with no nodes of its own, the Machine field is gone. A second machine brings it back, even if only one of them can take a subshell today.

Switching off launching on the server now applies to admins as well. It always read as a setting about the instance, but an admin's instance-wide access quietly exempted them from it — so the one person who could turn it off was the one person it did nothing to. The server's node page stays visible and manageable to them, which is the way back.

With nowhere left to launch, the form says so and offers the two ways out: switch the server back on, or add a node. Anyone can add a node; the first button appears only for someone who can actually take it, and everyone else is told who can.
