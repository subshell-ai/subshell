---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
"@internal/docs": patch
---

Keep preview redirects inside their proxy, preserve malformed app scripts for browser diagnostics, and bound concurrent rewriting by decoded bytes. Fix preview preferences on display-only nodes, reconnect grid tracking, launch-dialog cleanup, and node-settings links. Recover stalled capture writers between output bursts and rescue the Mac pointer after capture loss. Keep helper confirmations stable across state updates and clear them when settings reopen. Verify shared palette imports and refresh the preview documentation screenshots.

Reserve terminal input capacity per node so an offline machine cannot consume the fleet's budget, give a keystroke on a live pane the capacity a stuck retry was holding before disconnecting anyone, and drop held input immediately during forced viewer recovery. Prune obsolete helper staging copies after a successful install while preserving recovery data on failure. Dismiss the helper's quit confirmation when Confirm is pressed, even where the native bridge is absent.
