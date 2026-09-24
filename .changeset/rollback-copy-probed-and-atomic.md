---
"@internal/server": patch
---

`subshell-server update` keeps its rollback copy atomically (temp + fsync + one rename where hardlinks are refused, so an interrupted copy can never leave a truncated `<binary>.previous`), and both paths that install that copy back — `update --rollback` and the boot-time revert — now probe it first (`<previous> version` must exit 0). The CLI refuses outright when the copy cannot run; the automatic revert records the failure in `failed.json` and leaves the bootable new binary in place rather than putting an unbootable file where the service manager would try to exec it.
