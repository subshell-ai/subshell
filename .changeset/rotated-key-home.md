---
"@internal/node": minor
"@internal/server": minor
---

Rotated keys have a way home. `subshell configure` takes `--key`: it stores the rotated node key the node's page shows once in that machine's own config, keeping the node's identity and spending no setup key, and it refuses an `nsk_` setup key by name so the two credentials cannot be confused at a terminal. On the node page, Rotate key is now a dedicated card that ends with the two copyable commands which install the new key and bring the node back, plus a Client App tab saying plainly that Subshell Client takes a setup key and registers a new node, so a node key belongs on the command line. The rotate response's guidance line names the real command at last; the `subshell config` verb it used to name has never existed.
