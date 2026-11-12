---
"@subshell-ai/plugin-codex": patch
---

Codex subagents in the sidebar are status-only again. Clicking a child no longer drives Codex's `/subagents` picker: the removed driver walked the picker's painted rows by hand, and returning to the parent often couldn't find the `Main` row, which surfaced as "Couldn't switch agent views." Use Codex's own `/subagents` picker to switch views.
