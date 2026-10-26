---
"@internal/server": minor
"@internal/node": minor
"@internal/docs": patch
---

Presets can now be switched off. A new toggle in the presets table parks a preset without deleting it: a switched-off preset disappears from every launch picker and from the MCP `list_presets` answer, and starting or restarting a subshell with one is refused until you switch it back on. Panes already running from it are untouched.
