---
"@internal/server": patch
"@internal/node": patch
---

Fix "Update all" handing every node but the first an empty download. When several machines asked at once, the shared fetch handed out one spent stream; each caller now opens its own read of the finished download, and a digest mismatch fails the fetch before any byte is served.

Say more when an update refuses or stalls. The "not supervised" refusal now names whether a service definition exists on that machine and, for a launchd domain that needs someone signed in at the display, says so. When the swap lands but the restart is refused, the node reports the new binary as installed, shows the manager's own reason, and names the two ways to get it running.
