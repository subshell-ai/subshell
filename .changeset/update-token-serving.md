---
"@internal/server": patch
---

A node update now serves the verified release bytes even when this server's artifact cache holds an older binary, and the refusal remains only for a plane that cannot fetch. The update token carries the digest the update command named, so the download is measured against that release rather than against whatever the disk holds.
