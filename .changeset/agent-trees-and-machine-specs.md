---
"@internal/server": minor
"@internal/node": minor
"@internal/docs": patch
---

Group workspace subshells by machine and nest agent-created helpers beneath their creator. Include operating system, architecture, CPU model, logical CPU count, total RAM, and the hardware report timestamp in MCP node discovery.

Keep agent-created helpers out of standalone sidebar and dashboard listings. Select a helper beneath its parent to open it as a workspace tab.

Prevent dragging agent-created helper rows independently of their parent.
