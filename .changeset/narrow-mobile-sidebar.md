---
"@internal/server": patch
---

Set the mobile sidebar width to 264px to leave more of the workspace visible, and remove its close button. Tap outside the sidebar to close it.

Correct fullscreen iOS PWA height when the reported viewport omits the status bar. Keep only a 4px gutter beneath the mobile sidebar buttons and terminal keys and remove duplicated home-indicator padding below the phone workspace's terminal key bar.

Show node and sharing trust indicators once in the phone workspace header instead of repeating them over the terminal.

Exclude agent-created helper subshells from the New workspace and Add a subshell pickers.

Keep harness child rows collapsed by default unless their parent subshell is selected.
