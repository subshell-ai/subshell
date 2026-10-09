---
"@internal/server": patch
"@internal/node": patch
"@internal/desktop-server": patch
"@internal/desktop-client": patch
---

Use the server or an enrolled node as either the connecting machine or the source of selected SSH agent keys. Preserve machine trust through explicit identity recovery, include server relay identity files in backups, and close relay sockets on shutdown. Block concurrent connections during identity repair and require verified restoration of quarantined trust files. Refuse relay socket paths that OpenSSH cannot use with guidance to shorten the connecting machine's data directory.
