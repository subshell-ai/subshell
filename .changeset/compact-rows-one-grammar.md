---
"@internal/server": patch
---

Menus and pickers share one row density now. Action-menu rows tightened from 36px to 32px, and every picker sizes its popup list to its own control: full-size pickers keep the same 32px rows the menus use, and the sidebar's compact workspace and grouping pickers open compact lists that fit their triggers instead of a popup bigger than the control that opened it.

Use 13px text for action-menu items while keeping their compact 32px rows.
