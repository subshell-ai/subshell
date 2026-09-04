# @internal/server

## 1.4.0

### Minor Changes

- [`3919816`](https://github.com/subshell-ai/subshell/commit/3919816ec918db3931fb5b3560442727c36f6aad) Thanks [@theogravity](https://github.com/theogravity)! - `subshell-server mcp` is a real subcommand — releases are back to ONE binary per triple.
  
  - The compiled server binary now hosts the MCP stdio server that every harness
    pane spawns (`subshell-server mcp`), so a server-only host self-resolves its
    MCP entrypoint with no companion artifact.
  - **BREAKING for 1.3.x paired installs:** the `subshell-mcp-<triple>` companion
    binary is RETIRED — `compile:release` and the release workflow no longer build
    or publish it. Hosts that installed the 1.3.x pair should update
    `subshell-server` alone and delete the stale companion; the server IS the shim
    now. Also **remove any `SUBSHELL_MCP_COMMAND`/`SUBSHELL_MCP_ARGS` keys from
    `config.env`** after upgrading: the env override short-circuits the ladder
    without an existence check, so a leftover override keeps baking the deleted
    companion's path into every new pane and no `status` output warns about it.
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

## 1.3.0

### Minor Changes

- [#7](https://github.com/subshell-ai/subshell/pull/7) [`a23e435`](https://github.com/subshell-ai/subshell/commit/a23e4352ff3f3988d40c0dbea997fa076803aeb6) Thanks [@theogravity](https://github.com/theogravity)! - Fix `subshell mcp` entrypoint resolution for standalone installs, and make releases self-contained.
  
  - The launch resolver moved to `services/mcp-resolve.ts` and gained two rungs: the compiled-sibling check now matches the `subshell-server*` executable (it was pinned to the pre-rename `backend` name — silently dead), and a new last-resort rung uses the `subshell` node agent on PATH when one exists. Plain-dist deploys are unchanged (the dist rung still wins).
  - `compile:release` now publishes a `subshell-mcp-<triple>` companion binary beside every server binary (signed + notarized on darwin, digests included). Installing the pair side by side lets a server-only host self-resolve its MCP entrypoint — before this, a standalone release binary 500'd on first create.
  - `subshell-server status` prints the resolved `mcp entrypoint` and the rung that answered (or `UNRESOLVED`), so the gap surfaces at setup time instead of as a create failure.

## 1.2.1

### Patch Changes

- [`58d3941`](https://github.com/subshell-ai/subshell/commit/58d3941dd87458b91e91b36491144b8b7764bbbc) Thanks [@theogravity](https://github.com/theogravity)! - fix: opening the web UI on a fresh (never-registered) instance no longer
  freezes the browser tab — the first-run redirect into the setup wizard
  deadlocked itself in a render-phase navigation storm.

- [`edc49f4`](https://github.com/subshell-ai/subshell/commit/edc49f4dbf05bdf283d4f8918f0658eb0f2d9703) Thanks [@theogravity](https://github.com/theogravity)! - macOS release binaries are now Developer-ID signed and Apple-notarized by CI,
  so a browser-downloaded `subshell-server-darwin-*` / `subshell-darwin-*`
  passes Gatekeeper with the ordinary one-time "downloaded from the internet"
  confirmation instead of the "is damaged and can't be opened" refusal.

## 1.2.0

### Minor Changes

- [`87d9edb`](https://github.com/subshell-ai/subshell/commit/87d9edb5716a9f08dbb0ddf376ddfb3cb11f998d) Thanks [@theogravity](https://github.com/theogravity)! - Sidebar upgrade (rides the embedded SPA): recent sessions carry live status dots — working / idle / waiting-for-you / exited / ended / node-unreachable, one precedence shared with the home cards — and the rail sorts them live-first (waiting → working → idle → node-offline → exited → ended). A filter field searches all sessions; `+` buttons launch a subshell or open the new-workspace dialog, which now lets you pick existing sessions (multi-select) or launch one BEFORE the workspace exists. Sessions can be dragged from the sidebar straight into a workspace dock (adds a pane, focuses an existing one, never duplicates) or onto a workspace card. One SSE feed at the app root keeps every list current on every page.

## 1.1.0

### Minor Changes

- [`a76236e`](https://github.com/subshell-ai/subshell/commit/a76236e1c09cab7a3d93048198cc8e7bc8f7cb5a) Thanks [@theogravity](https://github.com/theogravity)! - Remote folder picking: the new-subshell form's folder picker now browses the selected node, not just the control-plane host. The agent answers a new `fs_ls` command (node protocol v3, additive — v2 agents stay connected and merely can't be browsed: the picker says so); `GET /api/files/explore?node=<id>` dispatches it signed and passes the listing through in the local shape.
