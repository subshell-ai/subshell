---
"@internal/server": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Harden instance backup and restore after review. A native parent now defers respawning while a control-plane restore holds the instance swap, so the swap no longer races a respawn for the lock. Boot confirmation gets a budget separate from the stop wait, so a slow healthy boot is not rolled back; a stored start choice survives to apply time; a re-applied completed restore is refused honestly instead of echoing a stale success; a failed or expired worker always reports and clears its secret file; abandoned download slots expire; a rolled-back prepared database removes its WAL sidecars; the state-write lock closes its handle when a release refuses; the client desktop registers the dialog plugin its download notice needs; and container one-shot invocations run once instead of respawning.
