---
"@internal/server": patch
"@internal/docs": patch
"@subshell-ai/plugin-api": minor
"@subshell-ai/plugin-codex": patch
---

Codex subagents now show their own task names in the sidebar instead of generic numbered labels, and clicking one switches the parent pane to it. The Codex plugin declares native navigation and drives its own `/subagents` picker from the control plane; completed children stay listed there, so the picker row is chosen by the id it prints rather than by roster position. Hook integrations get a standard optional `subagents.select` method with pane `read`/`type` access, and the plugin chooses the picker row by the id Codex prints, verifies the highlight when the picker stays open, and records that row's id; if Codex closes the picker on the digit, the numbered row was the one whose printed id matched. Codex's monitoring hooks must still be reviewed once in `/hooks` before its rows appear.
