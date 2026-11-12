---
"@subshell-ai/plugin-codex": patch
"@internal/server": patch
"@internal/node": patch
---

Clicking a Codex subagent in the first nine picker rows now switches views by the row's own number shortcut instead of stepping the highlight down the list. A narrow pane walks a long list once: it pages forward to the first name match, jumps to the end, and checks the remaining pages backward, ending on the candidate instead of walking the whole list twice. Deeper rows still page and arrow, the only way Codex's picker reaches them.
