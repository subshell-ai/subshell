---
"@subshell-ai/plugin-claude-code": minor
"@internal/server": minor
"@internal/node": minor
---

Browser panes now learn the input modes the app inside them already owns, and the Claude Code classic-renderer switch is discoverable.

A pane whose application had already enabled alt screen or mouse reporting before you attached replayed a capture carrying none of that: the browser terminal could not know the app owned the mouse, so every wheel notch became a single arrow key through the socket ("slow scroll, no scrollbar"). The pane capture now leads with the escape sequences that announce the pane's live mode flags, measured against tmux 3.7c, so a fresh attach scrolls like a terminal on the machine: at the app's own speed. Vim, htop, and any mouse-reporting harness get this; apps that keep the plain screen keep the native scrollbar and scrollback untouched, and every server/agent version mix degrades to the old behavior rather than breaking.

The Claude Code preset editor now suggests `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, whose description names why you would set it: the classic renderer appends to scrollback, so the pane shows a real scrollbar. It is a per-preset choice, not a default; Claude Code's newer renderer keeps its no-flicker alt screen unless a preset says otherwise.
