---
"@internal/server": patch
---

Sidebar rows, subshell cards, pane headers, and the subshells table now clip long working directories from the front, so a long path still names its leaf: `…/projects/hmn-vm` instead of `/home/theo/projects…`. What tells two panes apart sits at the end of the path, and the full directory still reads whole in each row's tooltip.
