---
"@internal/server": minor
"@internal/mcp-core": minor
---

Agents can run one shell command in a terminal pane and get its exit code back: the MCP tool exec_in_terminal and the POST /api/subshells/:id/exec verb it rides type a command plus a sentinel line into a quiet terminal pane, wait, and answer completed with the shell's status or timed_out after touching nothing; every refusal (busy pane, agent-harness pane, a second exec on the same pane) types nothing.
