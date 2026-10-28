---
"@internal/server": patch
"@internal/node": patch
---

Update Better Auth and its API-key and passkey plugins to 1.7.14, and JOSE to 6.2.13. The server migrates existing authentication accounts to Better Auth's provider-based identity keys while preserving issuer separation, credentials and sessions. Downgrading the server requires restoring a backup made before this upgrade.
