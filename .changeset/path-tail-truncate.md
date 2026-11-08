---
"@internal/server": patch
---

Long working directories now clip from the front everywhere they appear in a narrow space, so a path still names its leaf: `…/projects/hmn-vm` instead of `/home/theo/projects…`. That's the sidebar rows, subshell cards, both pane headers, the subshells table, and the add-a-pane picker. What tells two panes apart sits at the end of the path, and the full directory still reads whole in each row's tooltip.
