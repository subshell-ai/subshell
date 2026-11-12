---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
"@internal/docs": patch
"@internal/website": patch
---

Ship the Codex sidebar change: Codex subagents are status-only again. Selecting a child no longer drives Codex's `/subagents` picker, and the rows explain that Subshell can't switch views in this harness; use Codex's own picker instead. The bundled CLIs and both desktop apps carry the updated built-in plugin.
