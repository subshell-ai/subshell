---
"@internal/server": patch
"@internal/node": patch
---

Typing `;` (or any input ending in one) into a pane now reaches the terminal: tmux's command parser silently consumed a trailing semicolon from every input frame, so a bare `;` keystroke typed nothing at all. A working directory whose name ends in `;` no longer splits the pane's launch command.
