---
"@internal/node": minor
"@internal/server": minor
"@internal/docs": patch
---

Paired nodes now look for a faster verified LAN connection at startup and reconnect, keeping the configured server address as a fallback. Discovery protects node credentials with the pinned control-plane identity and uses one-use connection tickets. Healthy connections stay in place to avoid interrupting running work.
