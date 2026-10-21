---
"@internal/server": patch
"@internal/node": patch
---

The MCP SDKs move to 2.3.1, taking the published fixes for the transport
advisories. The pane MCP server and its e2e client speak stdio, so nothing was
exposed: this is hygiene, not a patch for a live hole.
