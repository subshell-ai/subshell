---
"@internal/server": patch
---

A stale cached detection is no longer flagged in the SPA. The Nodes row's "inventory stale" badge is gone, and the harness card's caveat paragraph went with it (operator rulings 2026-10-10): nothing about a machine is stale when that flag fires, only the cached answer may be old, and a warning on a perfectly healthy row asserted a defect nobody had established. The launch picker's greyed options keep their hedge ("not installed on this node (harness list may be outdated)") because there the staleness changes what a choice means; everywhere else the docs say it. The word "inventory", which was the server's name for that cache and not anyone else's, stays out of user-facing copy.
