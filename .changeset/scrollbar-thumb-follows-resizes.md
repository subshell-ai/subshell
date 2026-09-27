---
"@internal/server": patch
---

After reloaded panels gained prior scrollback, xterm's new overlay scrollbar could sit still while the content scrolled. The terminal now re-syncs it after every resize it applies.
