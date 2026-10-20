---
"@internal/server": patch
"@subshell-ai/plugin-claude-code": patch
"@internal/node": patch
---

Show Claude subagent names and task labels, including spawns with an implicit agent type. Match background task metadata by agent ID when Claude reports it, and preserve names across repeated start events. Clarify that sidebar view switching is unavailable in the Subshell integration, rather than in the harness itself.

Hide Claude subagent descriptions in the sidebar because the reported labels do not match Claude’s live progress summaries. Keep names and status visible.
