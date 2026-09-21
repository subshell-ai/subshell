---
"@internal/desktop-server": patch
---

The recovery screen's secondary actions stack one per row instead of running together on a single line, and they take a press reliably: the background poll no longer tears down and rebuilds the screen every 1.5 seconds when nothing has changed.
