---
"@internal/server": minor
"@internal/node": patch
"@subshell-ai/plugin-claude-code": patch
---

Notifications get quieter. A Stop hook no longer rings "Done, waiting for you" while the session is parked on background work; approval pushes fire only for the notification types that genuinely need a human; a pane pushes at most once until its owner opens it, escalation excepted; and the sidebar dot becomes a bell for exactly as long as a push sits unanswered.
