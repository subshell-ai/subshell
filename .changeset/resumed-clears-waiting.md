---
"@internal/server": minor
"@internal/node": patch
"@subshell-ai/plugin-claude-code": patch
---

"Waiting for you" now clears on agent nodes. The only alive-path clearer was the plane's idle watcher, which can only observe a log on the plane's own disk — so a pane running on a node stayed amber from its last Stop or approval until the process died, however hard it worked. Claude Code's hooks now report a third attention kind, `resumed` (prompt submitted, or a tool starting after an approval), and the pane's own report clears the stamp from wherever it runs; it never reads the hook payload and never rings. Rollout: update the Server first; an older `subshell` binary treats `resumed` as an unknown argument and says nothing, which is the pre-fix behaviour, not a failure.
