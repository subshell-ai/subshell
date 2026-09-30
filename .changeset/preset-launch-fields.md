---
"@internal/server": minor
---

Presets can carry the launch: an optional machine, working directory, and prompt blocks. Launches resolve them server-side (request wins, preset fills gaps), MCP `create_subshell` now launches from a preset addressed by id (`list_presets` hands out the ids), and a preset switched on ("Enable agents to create subshells with this preset") with a machine and a working directory set is cross-comm ready and badges as such; its prompt is optional. The "Copy settings from" launch picker is gone; presets carry that reuse.
