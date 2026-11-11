---
"@subshell-ai/plugin-codex": patch
---

Clicking a Codex subagent in the sidebar now reaches children that sit below the harness picker's eight-row viewport. The driver pages through `/subagents` and moves the highlight onto the id the picker printed before accepting, so a child past the ninth row (which the digit shortcut cannot select) switches the parent pane instead of failing with "Couldn't switch agent views."
