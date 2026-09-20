---
"@internal/server": minor
---

Server Settings → Logs: one tabbed page for the admin's two read-only logs. The audit trail — previously its own `/settings/audit` page — is the Audit tab, and the server's own log tail moved from Service to the System tab beside it; the nav entry renamed from "Audit log" to "Logs". The audit trail now pages (25 events a page, keyset cursors over the trail's total order) instead of showing only the newest 50, so a long trail is walkable to its beginning.
