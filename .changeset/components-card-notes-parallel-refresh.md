---
"@internal/server": patch
---

The Components table grew up around its three rough edges. The Server row and
the Nodes section now carry a Notes link to the release they name, the same
way the desktop rows always have. "Update all" orders every updatable machine
at once instead of one at a time, and each row states its own outcome, so one
refusal no longer silences the fleet. And refreshing the page mid-update keeps
its story: a server update still downloading resumes its progress lines, and
a node still installing keeps its spinner and its locked buttons, read from
the server rather than from the tab's memory.

@internal/desktop-server rides the bump automatically: it bundles this server
binary, and that is how the fix reaches a desktop-hosted instance.
