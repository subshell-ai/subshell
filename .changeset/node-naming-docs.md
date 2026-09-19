---
"@internal/docs": minor
---

The documentation says "node" where it means the node — the daemon that makes a
machine a node — and keeps "agent" for the harness a subshell runs, which is
what the word means everywhere else in the product. It also carries the release
tags' rename to `cli-server-v` / `cli-node-v`.

`/nodes/managing-the-agent` is now `/nodes/managing-a-node`. The old path is
gone rather than redirected.
