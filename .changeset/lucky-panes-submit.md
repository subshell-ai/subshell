---
"@internal/server": patch
"@internal/node": patch
---

Fixed prompts sent to a freshly launched agent pane sometimes sitting in the input box without submitting. Claude Code paints its UI well before it starts reading keystrokes, and an Enter that lands in that window gets swallowed with the burst it rode in on. Delivery now holds the Enter until the prompt text comes back on screen, which proves the pane is reading its input. A pane that never echoes the text (masked input, say) still gets its Enter when the wait runs out.
