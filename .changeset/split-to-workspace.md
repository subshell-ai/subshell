---
"@internal/server": minor
---

Split a running subshell into a workspace. The subshell page gains a **Split**
button that opens the add-subshell picker; the two subshells land side by side
in an unsaved workspace you can name later with **Save workspace…** or throw
away with **Discard**. Unsaved workspaces stay off the Workspaces page and the
sidebar, are discarded automatically once they hold fewer than two panes, and
the subshell page links back to the workspace it is on.
