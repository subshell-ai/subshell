---
"@internal/server": patch
"@internal/docs": patch
"@subshell-ai/plugin-api": patch
"@subshell-ai/plugin-claude-code": patch
"@subshell-ai/plugin-pi": patch
---

Claude Code and pi subagents are clickable in the sidebar. Claude Code drives its native agent panel, opening the selected child transcript; pi opens `/subagents-fleet` focused on the selected child, with `Esc` closing the inspector. pi's async children stay in the sidebar until their run completes instead of disappearing when the launching tool returns. Both paths require edit access for the pane's own input, and the plugin API now allows `subagents.select` on extension integrations as well as hook integrations.
