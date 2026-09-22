---
"@internal/server": patch
---

Keystrokes to a pane no longer wedge the queue when the plane-to-node write fails. A failed input write is held per browser session and re-fired in order the moment the node's connection is live again; a reconnect during the outage is retried instead of treated as terminal, and remounting the page no longer drops the stranded bytes.
