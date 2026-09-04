# @internal/server

## 1.4.1

### Patch Changes

- [`3ba6882`](https://github.com/subshell-ai/subshell/commit/3ba688286dc140c0d5dc6cc617830801357c0fa0) Thanks [@theogravity](https://github.com/theogravity)! - The subshell menu simplified: "Close" everywhere, no Terminate, implicit title pin, per-user terminal history.
  
  **"Close" is the new "Delete subshell"** across every human surface (menu,
  confirm dialogs, workspace pane header, bulk bar, the mobile app). Behavior is
  unchanged — the DELETE already stopped the process before removing the row.
  
  **Terminate left the human UI.** Close subsumes it (it terminates first), and
  stop-without-delete had no use-case; `POST /api/subshells/:id/terminate` stays
  for the agents' MCP tool `terminate_subshell`.
  
  **Renaming IS the title pin.** "Pin this title" / "Resume auto title" are gone
  from the menu, and `PATCH /:id/name` dropped its `autoTitle` flag: an explicit
  name locks the pane-title auto-naming sweep permanently, by design.
  
  **Operator notes are gone.** The "Add/Edit note" dialog, `PATCH
  /api/subshells/:id/notes`, and the MCP tool `update_subshell_notes` were
  removed with the feature — the human UI was its only reader. The
  `subshells.notes` column stays unread so a rollback finds its data.
  
  **Terminal history is now one per-user setting.** The per-subshell "Terminal
  history…" dialog and `PATCH /api/subshells/:id/replay` are gone; Account →
  "Terminal history" stores a single cap (`user_meta.terminal_replay_lines`,
  migration 0020) applied at attach on both the local and remote paths
  (`GET`/`PATCH /api/settings/terminal-history`, cookie session, 1–200 or null
  for the `SUBSHELL_TERMINAL_REPLAY_LINES` default). The old per-subshell column
  stays unread so a rollback finds its data.

- [`a30f823`](https://github.com/subshell-ai/subshell/commit/a30f8235a7b39b26f063f7c3efd6ac91e0a56d61) Thanks [@theogravity](https://github.com/theogravity)! - Service restarts no longer kill live panes, and restart-resume follows the pane's CURRENT conversation.
  
  **Keep the panes across a service restart.** The server and the node daemon
  spawn each pane's tmux server as a child inside their unit's cgroup, so
  systemd's default control-group kill SIGKILLed every live subshell on any
  stop/restart (observed 2026-09-01 and again 2026-09-03 when a renamed unit
  lost its manual drop-in). Generated systemd units now carry
  `KillMode=process` and launchd agents `AbandonProcessGroup` — panes are
  stateful daemons the boot reconciler / reconnect census re-adopts. Hosts
  already running a generated unit pick this up on the next `service install`.
  
  **SessionStart re-pins the harness conversation.** The claude-code harness
  pins the conversation id at launch (`--session-id`); when the pane switched
  conversation in-pane (/clear, /resume, /fork) the next restart resurrected
  the ORIGINAL launch transcript — a silently stale conversation. A new
  SessionStart hook reports the pane's current session id to
  `POST /api/subshells/:id/harness-session` (the subshell's own bearer,
  self-only like /attention), and restart-resume continues the current one.
  
  **Channel nudges now wake idle agents.** `post_channel(nudge:true)` used to
  type an inert, Enter-less line into a recipient pane — a human cue that woke
  nothing. A recipient that is idle at its prompt (waiting-for-you) now gets a
  submitted "read the channel" line and actually wakes to read it; a pane
  mid-turn still gets the old inert cue (submitting into a busy harness would
  corrupt its turn). The line is a fixed server string — peer message content
  stays E2EE and is only ever read via `read_channel`, never auto-executed.
  
  **The `subshell` MCP now introduces itself.** The server's `initialize`
  handshake carries an `instructions` briefing every harness sees at connect
  time: sibling panes are AGENTS you can question (`list_subshells` /
  `get_subshell` instead of guessing from git), coordinate through
  channels, and know that channel delivery is PULL — the peer only sees a
  post when it calls `read_channel`. (Bundles into both binaries with these
  bumps; `@internal/mcp-core` itself is changeset-ignored.)
  
  **Node-offline precedence on workspace panes.** A docked pane whose agent
  node is unreachable now says "Node offline — reconnecting" (the machine is
  unreachable; the subshell may still be RUNNING there) instead of rendering a
  dead-looking frozen terminal — the pane-surface twin of the precedence the
  cards and the detail badge already follow (spec §5.6). Pane rows from
  `GET /api/workspaces/:id` gained `subshellNodeId`/`subshellNodeOffline`.

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
