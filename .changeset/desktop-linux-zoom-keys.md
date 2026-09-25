---
"@internal/desktop-server": minor
"@internal/desktop-client": minor
---

Text size on Linux now answers Ctrl+= / Ctrl+- / Ctrl+0 in every window of both desktop apps. Until now those keys lived only on the macOS menu bar (a GTK menu bar is per-window chrome, so Linux carries none), leaving the tray's Text Size submenu as the only door, and no door at all on a session with no tray host. The tray submenu and the shared zoom ladder are unchanged.
