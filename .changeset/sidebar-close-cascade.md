---
"@internal/server": patch
---

Closing a subshell from the sidebar now closes its surfaces: the open subshell page leaves (it used to sit on cached data forever after its refetch answered 404), and an open workspace tab closes with it. Restart and Switch preset refresh the same read, so a dock tile stops showing a dead terminal after either act done from the rail or a card. A close made on ANOTHER device or over MCP now also wakes the dock — the live feed's gone frame re-reads the workspace detail, which nothing polled.
