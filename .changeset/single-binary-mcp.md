---
"@internal/server": minor
---

`subshell-server mcp` is a real subcommand — releases are back to ONE binary per triple.

- The compiled server binary now hosts the MCP stdio server that every harness
  pane spawns (`subshell-server mcp`), so a server-only host self-resolves its
  MCP entrypoint with no companion artifact.
- **BREAKING for 1.3.x paired installs:** the `subshell-mcp-<triple>` companion
  binary is RETIRED — `compile:release` and the release workflow no longer build
  or publish it. Hosts that installed the 1.3.x pair should update
  `subshell-server` alone and delete the stale companion; the server IS the shim
  now.
- The launch resolver collapses to a self-referencing ladder:
  `SUBSHELL_MCP_COMMAND`/`_ARGS` override → SELF (the server itself:
  `<execPath> mcp` when compiled, `<bun> <absolute entry> mcp` under
  `bun run`/dist) → the `subshell` node agent on PATH (safety net for servers
  that predate the self rung) → throw with the `SUBSHELL_MCP_COMMAND` hint.
  The module touches no fs.
- `subshell-server status` prints the resolved `mcp entrypoint = … (via …)` and
  the rung that answered (or `UNRESOLVED`), so a broken deployment shows up at
  setup time instead of as a create failure.
- better-auth construction is now lazy (`getAuth()`): the entry graph is
  IO-free at import. That is what makes the long-running `mcp` subcommand safe
  and keeps `version`/`status`/`init` from dragging boot side effects (a stray
  `data/subshell.db`) into the sync CLI path.
