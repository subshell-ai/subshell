---
"@internal/server": patch
---

The node-admin surface (the six node cards, their hooks and types, and the UI
primitives they render) moved out of the served SPA into a shared Apache-2.0
package, `@internal/node-admin`, so the node's own loopback dashboard can render
the same machine in the same words. The Nodes pages look and behave exactly as
before — this is the extraction's half in the server's binary, no visible change.
