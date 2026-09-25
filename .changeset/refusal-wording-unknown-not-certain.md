---
"@internal/server": patch
"@internal/node": patch
---

A service definition nobody could read is now refused with the honest sentence. The destructive verbs (node `stop`/`uninstall`/`restart`, node `update`, the server's own restart and update) already fail closed when the supervision definition reports `unknown` or nothing at all: one refusal code, because an unreadable definition is not evidence of safety. But the WORDING promised, with certainty, that every pane would die. Only a definition that actually answered `kills` earns that sentence now; `unknown` and no-report-at-all say the definition could not be read, on the plane's node surfaces, the node's own loopback dashboard, and the server's own restart and update routes alike.
