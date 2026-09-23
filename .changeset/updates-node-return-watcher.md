---
"@internal/server": patch
---

Fix the Updates page going mute after a node update actually succeeded. The POST answers the ACCEPTANCE (202); the machine's restart and its return on the new version happen after it — and the page, which deliberately does not poll, had nothing to notice that return. Rows sat at `0.15.0 → 0.15.1` with no version change and no success said, an operator-report of an update that had in fact worked. A row now says "Update accepted. {name} is installing {version} and will reconnect by itself" on the 202, polls the (already-cached) nodes read every 2 s for exactly as long as a machine is mid-update, flips to "Updated to X." the moment the node reports back — invalidating the page's own read so the version cells move too — and says so plainly rather than spinning forever if the machine has not returned after two minutes.
