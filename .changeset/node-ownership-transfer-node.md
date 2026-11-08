---
"@internal/node": minor
---

The Subshell MCP gained a `transfer_node` tool, so an agent launched from an automation key can hand a machine to another account the way the dashboard and the new `subshell-server node transfer` verb do. Like them it needs a credential carrying the `nodes:transfer` permission, an ordinary pane's own token is refused with a refusal that names the door. The tool rides the MCP server in both binaries, `subshell` and `subshell-server`; the new node share level (Manage) and the ownership transfer itself are covered by the server's entry this release.
