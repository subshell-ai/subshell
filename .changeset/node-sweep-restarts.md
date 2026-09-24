---
"@internal/node": patch
---

The node's pane-log retention sweep can no longer delete the transcript of a subshell that restarted while the sweep was running. The pass censused tmux once at the top and then walked the files; a restart landing in that window reuses the same log path append-only with the old mtime intact, and with the default window of ONE DAY almost any aged file is a candidate — so the sweep unlinked a live transcript out from under the capture child, and the pane kept writing the dead inode until a relaunch. Every eligible file is now re-probed with a fresh `hasSubshell` immediately before its own unlink; a probe that cannot answer counts the pane running, the census's own unknown-is-not-dead rule. An orphan log (no record to probe) still ages out — that is what a missed delete leaves behind.
