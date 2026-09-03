---
"@internal/server": minor
---

Fix `subshell mcp` entrypoint resolution for standalone installs, and make releases self-contained.

- The launch resolver moved to `services/mcp-resolve.ts` and gained two rungs: the compiled-sibling check now matches the `subshell-server*` executable (it was pinned to the pre-rename `backend` name — silently dead), and a new last-resort rung uses the `subshell` node agent on PATH when one exists. Plain-dist deploys are unchanged (the dist rung still wins).
- `compile:release` now publishes a `subshell-mcp-<triple>` companion binary beside every server binary (signed + notarized on darwin, digests included). Installing the pair side by side lets a server-only host self-resolve its MCP entrypoint — before this, a standalone release binary 500'd on first create.
- `subshell-server status` prints the resolved `mcp entrypoint` and the rung that answered (or `UNRESOLVED`), so the gap surfaces at setup time instead of as a create failure.
