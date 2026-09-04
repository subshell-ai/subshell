# @internal/client

## 0.2.3

### Patch Changes

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

## 0.2.2

### Patch Changes

- [`edc49f4`](https://github.com/subshell-ai/subshell/commit/edc49f4dbf05bdf283d4f8918f0658eb0f2d9703) Thanks [@theogravity](https://github.com/theogravity)! - macOS release binaries are now Developer-ID signed and Apple-notarized by CI,
  so a browser-downloaded `subshell-server-darwin-*` / `subshell-darwin-*`
  passes Gatekeeper with the ordinary one-time "downloaded from the internet"
  confirmation instead of the "is damaged and can't be opened" refusal.

## 0.2.1

### Patch Changes

- [`87d9edb`](https://github.com/subshell-ai/subshell/commit/87d9edb5716a9f08dbb0ddf376ddfb3cb11f998d) Thanks [@theogravity](https://github.com/theogravity)! - Reliability: the agent's subshell-meta mirror can no longer be poisoned by a read racing a forget — a per-id generation counter refuses the stale refill, so a forgotten subshell actually reads as gone (this was the watcher tests' historical flake).

## 0.2.0

### Minor Changes

- [`a76236e`](https://github.com/subshell-ai/subshell/commit/a76236e1c09cab7a3d93048198cc8e7bc8f7cb5a) Thanks [@theogravity](https://github.com/theogravity)! - Remote folder picking: the new-subshell form's folder picker now browses the selected node, not just the control-plane host. The agent answers a new `fs_ls` command (node protocol v3, additive — v2 agents stay connected and merely can't be browsed: the picker says so); `GET /api/files/explore?node=<id>` dispatches it signed and passes the listing through in the local shape.
