---
"@internal/node": patch
"@internal/desktop-client": patch
"@internal/server": patch
---

Reload updated node credentials and server addresses before dialing and on the heartbeat, preserving running subshells. Add search, status, and access filters to the Nodes table, and describe address changes without requiring a restart.

Reject WebSocket URL fragments and invalid credential headers before replacing the running connection, without logging credentials.
