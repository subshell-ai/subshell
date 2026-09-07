---
"@internal/client": patch
---

Fixed how the agent names itself when re-entering its own binary.

Two callers do it — the service unit's `ExecStart` (`<self> run`) and every
pane's MCP registration (`<self> mcp`) — and they decided separately. Only one
decided correctly: the MCP registration passed `process.execPath` bare, which
under a source run is the `bun` binary, so a dev agent registered `bun mcp` for
its panes. That is not a command, so those panes got an MCP entry that could
never start.

Both now share one decision, which also fixes a case neither handled: a
compiled agent RENAMED to something not starting with `subshell` was treated as
an interpreter launch and had its virtual `/$bunfs/…` argv[1] baked into the
service unit, producing an `ExecStart` that cannot run. It is now correctly
treated as compiled.
