# @internal/node

## 0.5.0

### Minor Changes

- [`c694cdd`](https://github.com/subshell-ai/subshell/commit/c694cddf53a186a11c1e5e4e82e137fcfc6e149a) Thanks [@theogravity](https://github.com/theogravity)! - `subshell service` gains `status`, `start`, `stop` and `restart`, so an agent
  can be managed without dropping to `systemctl --user` or `launchctl` — and
  `subshell service status --json` reports what the service manager actually
  says, including whether the installed definition would survive a restart.
  
  **A restart that would kill live panes is refused.** A node runs its subshells'
  tmux servers as children of its own unit, so a definition without
  `KillMode=process` (systemd) or `AbandonProcessGroup` (launchd) takes every
  running subshell on that machine down with it. Current installs carry both; a
  machine that installed an older agent has a stale definition on disk, and the
  effective setting is read from the service manager rather than the file, so a
  drop-in cannot hide it. `--force` overrides, and `stop` warns and proceeds.
  
  `subshell enroll --json` reports the resulting node id, server URL, name, data
  directory and config path. The node key is never included — its only home is
  the 0600 config file.

## 0.4.1

### Patch Changes

- [`77168d5`](https://github.com/subshell-ai/subshell/commit/77168d527fe6cd95edcc0f70cdddc435215d3e61) Thanks [@theogravity](https://github.com/theogravity)! - Per-node directory allowlist: restrict where subshells may be created.
  
  A node grants arbitrary command execution under its OS user to anyone who can
  launch there, and any node share confers that. A node owner can now say "on
  this machine, only under these directories".
  
  - `PUT /api/nodes/:id/allowed-dirs` (owner-only, audited) stores the rules and
    pushes them to the node. **An empty list means unrestricted**, so existing
    nodes are unaffected.
  - Enforced twice: the control plane checks the resolved working directory at
    create and restart, and the node checks every launch against a copy it
    persists itself — signing proves who sent a launch, never whether the
    directory is permitted.
  - The folder picker is scoped to the rules for anyone who cannot manage the
    node; the owner browses unfiltered, since they browse in order to choose
    what to permit.
  
  **Node protocol v4 → v5, and the agent floor rises to 0.4.0.** The protocol is
  matched exactly, so every enrolled node must be updated to this release or it
  is refused at connect. Server and client must be released together.

## 0.3.1

### Patch Changes

- [`87e58d0`](https://github.com/subshell-ai/subshell/commit/87e58d02709ed79ea4e87504b31d9a95f4a9aa25) Thanks [@theogravity](https://github.com/theogravity)! - Move the agent's logging onto LogLayer, matching the server.
  
  `src/log.ts` was the last hand-rolled logger in the repo — a bare `console.log`
  with a manual timestamp. It is now LogLayer with the core `ConsoleTransport`,
  both of which ship inside the `loglayer` package, so the compiled agent binary
  gains no third-party dependency.
  
  Output is byte-identical: `[subshell <ISO>] <message>`, still on stdout. What
  changes is what the agent CAN now do — levels, `withError()`, `withMetadata()`,
  and a swappable transport — none of which the previous logger allowed.
  
  Errors are flattened to plain strings by a four-line `errorSerializer`, because
  handing Bun's console a raw `Error` inside a `--compile --bytecode` binary
  prints the entire minified bundle as source context (~25 KB per call).

- [`a0b4377`](https://github.com/subshell-ai/subshell/commit/a0b4377301afcde5bd6d97492cf5cda75dc59c1b) Thanks [@theogravity](https://github.com/theogravity)! - Make the running version answerable everywhere it is asked.
  
  - `subshell --version` / `-v` now work. They alias the `version` subcommand,
    but only in the command slot: argv[0] IS the command in this parser, so
    `subshell status --version` remains an unknown flag, because it is a typo
    rather than a request for the version.
  - The server LOGS its version as the first line of boot, before anything can
    fail. After a restart, which build came up decides how to read every line
    beneath it — and the service manager restarts whatever binary sits at the
    unit's ExecStart path, which is not always the one you assume.
  - `subshell-server status` opens with the same `subshell-server <version>`
    line the `version` subcommand prints. "Which build is this host running?"
    is the question that decides whether the rest of the output is even
    relevant, and status could not answer it.
  - `GET /api/meta/status` reported a hardcoded `appVersion: "1.0.0"` while the
    server was at 1.5.0. It now derives from `SERVER_VERSION`, with a test that
    compares the two so the drift cannot recur.
  - `GET /api/settings/public` gains `serverVersion`, and Preferences gains an
    About section showing it beside the bundle build id. The two version
    independently, and a bug report needs the pair.
  
  No `--version` flag on `subshell-server`: a leading `-` there is the boot path
  by contract (svc.sh and systemd pass flags, never subcommand words), so the
  flag would have to carve an exception out of the one rule that keeps the
  service deployment byte-identical. `subshell-server version` and now `status`
  both answer instead.

## 0.3.0

### Minor Changes

- [`d938d7f`](https://github.com/subshell-ai/subshell/commit/d938d7fe65b055aa51b82a7f396022682f8b80be) Thanks [@theogravity](https://github.com/theogravity)! - Node panes now report their real grid, so several devices watching one
  subshell on an agent node agree about its size.
  
  A tmux pane has one grid and is sized to the smallest viewer, and the server
  announces that grid for clients to pin their terminal to. On the control-plane
  host it could read the pane back, so the announcement was confirmed. On a node
  it could not — the protocol had no size command — so it announced the size it
  had *asked for*: exact for one viewer, a guess for several, and wrong for
  everyone if tmux clamped the request. Protocol v4 adds `pane_size`, and the
  announcement is now confirmed on every machine.
  
  The agent protocol is also matched exactly now, in place of the old
  compatibility window and its per-feature version gates. Server and agent ship
  together, so an agent reporting any other version is refused at `ready` and
  its node is chipped "agent too old" or "agent too new" — naming which side to
  redeploy instead of leaving a bare "offline".

### Patch Changes

- [`1354ff8`](https://github.com/subshell-ai/subshell/commit/1354ff899333ee1e71659ae9830289c4ec0d2e94) Thanks [@theogravity](https://github.com/theogravity)! - Fix two path bugs that only surfaced on macOS.
  
  `SUBSHELL_FS_ROOT` confinement compared the unresolved candidate path against
  a realpath-resolved root, so a root reached through a symlink refused
  everything — including itself. `/tmp` is a symlink to `/private/tmp` on macOS,
  so setting the root to `/tmp/x` returned 403 for `/tmp/x`, locking the operator
  out of the directory they had just configured. The permission boundary is
  unchanged: the realpath comparison still decides, and only the two legitimate
  spellings of the configured root now pass the cheap pre-check.
  
  The node agent's `fs_ls` reported `ENOENT` for every path-lookup failure,
  swallowing `EACCES`. Since the control plane maps `ENOENT` to the folder
  picker's 404 and `EACCES` to 403, an unreadable directory told the operator it
  did not exist. Which call raises the error is platform-dependent — `realpath`
  refuses on macOS while Linux reaches `readdir` first — so the error class is
  now preserved at every step.

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
