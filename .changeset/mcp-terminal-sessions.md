---
"@internal/server": minor
---

Agents can open plain terminal sessions on their machines: MCP create_subshell launches the built-in terminal harness with no preset (agent harnesses still require one), an omitted working directory starts the shell in the node's home, and read_subshell_log gained a byte cursor (from_byte/nextByte) so a pane can send commands and read each new line exactly once.
