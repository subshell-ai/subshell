---
"@internal/server": minor
"@internal/docs": patch
---

Machine credentials now hold their account's node authority. A pane's MCP token can launch a subshell wherever its user could launch one from the browser: machines the account owns or that are shared with it, machines reached through an administrator's instance-wide access, and the control-plane host when the account's launch grant there allows it. Previously every bearer was held to an owner-only node list, so a preset pinned to a machine the account could already use answered "Node not found". `list_nodes` now returns the same non-admin set the browser shows, and a refusal names its rule (a maintenance window, the server settings switch, or a missing launch grant) instead of reading as a missing machine.
