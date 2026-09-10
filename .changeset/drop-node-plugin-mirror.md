---
"@internal/server": patch
---

**The per-node plugin mirror is gone from the schema.** Migration 0026 now completes the ownership move it opened: `nodes.plugins_json` / `nodes.plugins_at` — the columns that mirrored each node's report of its installed set, from when the node owned that answer — are dropped, and the instance-level `plugin_state` table (the `enabled` flag, absent row = enabled) arrives in the same change. Nothing read the mirror after the inversion; the protocol stopped carrying the report in v3, and the `NodesRepository` writer for it is deleted with it.
