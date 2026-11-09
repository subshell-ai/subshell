---
"@internal/docs": patch
"@subshell-ai/plugin-api": minor
"@subshell-ai/plugin-oh-my-pi": patch
"@subshell-ai/plugin-claude-code": patch
---

Harness plugins can now interpret their own terminal title: `parsePaneTitle(raw)` strips the brand, run-state separator, or status glyph a harness writes around the session name. Oh My Pi uses it for `π <state> <label>`, and Claude Code for its cycling status glyph. The control plane keeps only the sanitising every title needs (escape sequences, control bytes, terminal-protocol payloads) instead of knowing either harness's title format.
