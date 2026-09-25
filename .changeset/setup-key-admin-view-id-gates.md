---
"@internal/server": minor
---

Three security fixes from the 2026-09 documentation sweep, operator-approved.

**Admins can now see and revoke every setup key on the instance** (audit item 4). An outstanding key that its creator never used used to be an enrollment door no admin could close before its 24 h expiry: the list was owner-scoped and the delete owner-filtered. `GET /api/nodes/setup-keys?all=1` is now the cookie-admin view (every key, each labeled with its creator), and `DELETE` closes any row, audited `setup_key.revoke` with `{ foreign: true, ownerUserId }` metadata (ids only, never the key text). A non-admin asking for `all=1` gets a 403 rather than a silently-narrowed list. The Setup keys card on the Nodes page gained the matching switch, and each foreign row shows who created it.

**The backend gates subshell ids before interpolating them into node-side paths** (audit item 7). The agent has always checked `isNodeSubshellId`; the plane now checks the same guard at every composition site (`assertNodePathId` in `services/nodes/node-path-id.ts`, called by the `RemoteLauncher` path members and the launch-side `planRemoteSubshellMcp`), so "a hostile `../../../../x` never reaches path interpolation" is true on both sides of the link instead of true by the accident that every id today is a server-minted uuid.

**The WebSocket attach-token store is capped** (audit item 8). Mints became machine-reachable in #159 and the in-memory store had no limit; past `MAX_PENDING_WS_TOKENS` (10 000) the mint sweeps expired tokens first and then answers a named 503 rather than growing memory on a script-rate caller's schedule.
