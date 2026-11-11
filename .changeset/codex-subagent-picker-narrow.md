---
"@subshell-ai/plugin-codex": patch
---

Clicking a Codex subagent in a narrow pane now switches the parent terminal instead of failing with "Couldn't switch agent views." Codex hides the picker's id column when the row names leave fewer than 24 columns beside them, so the driver falls back to the child's printed name (including the canonical `/root/` path the picker shows, rejoined when the row wraps) and still verifies the highlighted row before pressing Enter. When two rows print the same name, it refuses to guess instead of switching to the wrong child.
