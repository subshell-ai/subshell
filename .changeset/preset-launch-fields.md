---
"@internal/server": minor
---

Presets can carry the launch: an optional machine, working directory, and prompt blocks. Launches resolve them server-side (request wins, preset fills gaps), MCP `create_subshell` now launches from a preset, and a preset switched on for "Cross-subshell comms" with all three set is cross-comm ready and badges as such. The "Copy settings from" launch picker is gone; presets carry that reuse.
