---
"@internal/server": minor
"@internal/node": patch
"@internal/docs": minor
"@subshell-ai/plugin-api": minor
"@subshell-ai/plugin-claude-code": patch
"@subshell-ai/plugin-codex": patch
"@subshell-ai/plugin-opencode": patch
"@subshell-ai/plugin-hermes": patch
"@subshell-ai/plugin-pi": patch
---

Show active harness subagents beneath their parent subshell. Each row carries a hover card with its status, how long it has been running and, where the harness gives one, its own one-line task label (Claude Code and Hermes do). OpenCode's native integration switches the existing terminal view and updates its compact header; other integrations expose lifecycle status. Switching moves the shared terminal view onto any reported agent; typing still needs edit access. Add companion integration files to node launches.
