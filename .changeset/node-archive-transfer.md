---
"@internal/server": minor
"@internal/node": minor
---

Nodes can hand trees of files to each other: a new MCP tool transfer_files copies or diff-syncs a directory between two agent nodes, relayed as one streamed archive through the server, with no tar or rsync needed on either machine. The node protocol becomes 15 to carry the five archive commands, so update the server before the nodes: a lagging agent is held and crosses the bump on the update command. Endpoints must be nodes the caller owns and that are out of maintenance, each node's operator directory allowlist gates its side, and extraction is additive: matching files are overwritten and nothing is deleted.
