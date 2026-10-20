---
"@internal/server": minor
"@internal/node": patch
"@internal/docs": minor
"@internal/website": patch
"@subshell-ai/plugin-api": minor
"@subshell-ai/plugin-claude-code": patch
"@subshell-ai/plugin-codex": patch
"@subshell-ai/plugin-opencode": patch
"@subshell-ai/plugin-hermes": patch
"@subshell-ai/plugin-pi": patch
---

Show active harness subagents beneath their parent subshell, each with a hover card: status, how long it has run, and the harness's own one-line task label where it supplies one (Claude Code and Hermes). OpenCode's native integration switches the existing terminal view and updates its compact header; other integrations expose lifecycle status. Viewers can navigate the shared view while terminal input still requires edit access. Add companion integration files to node launches.

Refresh the desktop website demo and README animation with a real Codex subagent task and compact sidebar navigation.
