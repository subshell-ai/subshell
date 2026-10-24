---
"@internal/server": patch
---

Fix action menus running past the bottom of the screen. A menu taller than the space available (the subshell actions menu on a phone or short window) is now clamped to the viewport and scrolls within it, instead of its last items falling off the bottom where nothing could reach them.
