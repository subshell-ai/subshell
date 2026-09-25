---
"@internal/server": minor
"@internal/node": patch
"@subshell-ai/plugin-claude-code": patch
---

"Waiting for you" now clears on agent nodes. The only alive-path clearer was the plane's idle watcher, which can only observe a log on the plane's own disk, so a pane running on a node stayed amber from its last Stop or approval until the process died, however hard it worked. Claude Code's hooks now report a third attention kind, `resumed` (prompt submitted, or a tool starting after an approval), and the pane's own report clears the stamp from wherever it runs; it never reads the hook payload and never rings. Rollout: update the nodes FIRST, then the Server. The Server ships the new hook, and an older `subshell` binary rejects `resumed` as an unknown argument with exit 2, which Claude Code reads as a blocking error on every prompt and tool, so a node left behind stalls its panes until it updates. An updated node against an older Server is harmless: the report is a silent no-op there.
