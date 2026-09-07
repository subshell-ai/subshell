# @internal/server

## 1.9.0

### Minor Changes

- [`249bbba`](https://github.com/subshell-ai/subshell/commit/249bbbaac7bc113bd8d2a1e3ae60ddacf8774fe2) Thanks [@theogravity](https://github.com/theogravity)! - `service start|stop|restart|status` and `status --json`.
  
  Starting and stopping the server no longer means reaching for `systemctl --user`
  or `launchctl` — the CLI drives the per-user service on both platforms, and
  `service status` reports what the manager is actually doing (run state, pid,
  starts-at-login) rather than only whether a definition exists on disk.
  
  The reason the control verbs live here rather than in a wrapper: each local
  subshell's tmux server is a **child** of the service, so a definition written
  before the `KillMode=process` / `AbandonProcessGroup=true` fix takes every
  running subshell down with it — on stop as much as on restart. `service
  restart` refuses on such a host (`--force` overrides), `service stop` warns and
  proceeds, and `service status` reports it as `teardown keeps panes`. On Linux
  the check asks systemd for the **effective** `KillMode`, so a drop-in under
  `subshell-server.service.d/` is seen; a bare `systemctl --user stop` says
  nothing about any of this.
  
  `status --json` emits the same facts as the text view for scripts and other
  processes. It never carries `BETTER_AUTH_SECRET` in any form — only `set` or
  `missing`.
  
  **Behaviour change:** `status` previously ignored unrecognised arguments and
  exited 0. It now refuses them with a usage error, so a typo'd `--jsonn` cannot
  silently hand a script prose it has no way to parse. Valid invocations still
  always exit 0.

### Patch Changes

- [`74952f0`](https://github.com/subshell-ai/subshell/commit/74952f07d19a3af6ae17fb6ec51a76a1738644ae) Thanks [@theogravity](https://github.com/theogravity)! - Fix the node enroll flow on binary-only server installs. `GET /api/settings/public` now reports `nodeArtifactTargets` — the triples `/api/downloads/node/*` actually serves — so the Add-node dialog warns when the copyable install one-liner would 404 and shows the `subshell enroll` fallback instead; the rendered `install.sh` now prints the same guidance instead of dying with a bare `curl(22)`.

## 1.8.0

### Minor Changes

- [`9a97acc`](https://github.com/subshell-ai/subshell/commit/9a97acc76ee3dad606984b6ece791ca0deccc489) Thanks [@theogravity](https://github.com/theogravity)! - Admins can assign roles and reset other users' passwords.
  
  Creating users already existed; this adds the two operations that were missing
  from the Users page.
  
  - `PATCH /api/users/:id/role` — assign Admin or User. **Demoting the last admin
    is refused**, counted and written in one transaction so two concurrent
    demotions cannot both succeed and leave an instance nobody can administer.
    Stepping down yourself is allowed while another admin remains.
  - `PATCH /api/users/:id/password` — set another user's password and **sign them
    out of every device**. A reset is usually an answer to "this account may be
    compromised", so leaving live sessions would achieve nothing.
  
  Both are admin-only over a browser session; bearer keys are refused like every
  other admin surface. The `system` service account cannot be modified, and an
  admin cannot reset their own password here — Account is the path that requires
  the current one. Audited as `user.role_change` and `user.password_reset`; the
  password itself is never logged, echoed, or audited.

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

## 1.7.0

### Minor Changes

- [`0fccb6d`](https://github.com/subshell-ai/subshell/commit/0fccb6d2fd74d38604caff90a808c085d6bca920) Thanks [@theogravity](https://github.com/theogravity)! - Harden pane-log storage and disclose subshell exposure in the UI.
  
  Pane logs are the verbatim transcript of a session — a terminal echoes, so they
  hold typed secrets as well as command output. They were created world-readable
  (0644 in a 0755 directory) and unlinked only when a subshell was deleted, so a
  terminated-but-kept subshell held its transcript for the life of the instance.
  
  - Logs are now created 0600 via a `umask 077` in the pipe-pane command, inside a
    0700 directory; a boot pass repairs logs written before this.
  - Logs of non-running subshells are swept after `SUBSHELL_LOG_RETENTION_DAYS`
    (default 30, `0` = keep forever). Running subshells are never swept.
  - Subshells running on a node you don't own, or shared with others, now carry a
    permanent icon in their header explaining who can read the terminal, plus a
    one-time banner (dismissible; per-device switch under Preferences).
  - The sharing dialog says that a grant exposes the existing scrollback, not just
    what happens next.

## 1.6.0

### Minor Changes

- [`e779e95`](https://github.com/subshell-ai/subshell/commit/e779e954061e8b186fdefadcd2622e2791bd65c2) Thanks [@theogravity](https://github.com/theogravity)! - Add an admin-only Server status page (`/settings/status`) backed by a new
  `GET /api/admin/status`.
  
  One read answers "is this instance healthy, and what is it running":
  
  - **Versions** — server, Bun runtime, node protocol, and the minimum agent
    version, plus the enrolled agents that fall below that floor. A refused
    agent otherwise reads as a plain offline node with nothing anywhere saying
    why; this names them and links to each.
  - **Runtime** — uptime, memory, host, listen address, SPA source
    (disk vs embedded), database path and size, tmux, resolved MCP entrypoint.
    The last two are badged as failures rather than merely printed: no tmux
    means every local pane launch fails, and an unresolved MCP entrypoint means
    every subshell create 500s, and both stay invisible until a user hits them.
  - **Inventory** — users/admins, subshells, nodes, workspaces, profiles,
    channels, counted server-side across every user.
  - **Security posture** — registrations, break-glass login, whether the auth
    secret is still the placeholder, and how many system API keys are active.
  
  Cookie-admin only, and bearer keys are refused even when their owner is an
  admin. The body carries no secret in any form — the auth secret and the
  break-glass password appear as booleans, and a test scans the serialized
  response for the real values so a field added later cannot regress that.

- [`87e58d0`](https://github.com/subshell-ai/subshell/commit/87e58d02709ed79ea4e87504b31d9a95f4a9aa25) Thanks [@theogravity](https://github.com/theogravity)! - Enforce a minimum agent version on `/ws/node`.
  
  `MIN_AGENT_VERSION` (currently `0.3.0`) is checked at `ready`, BEFORE the
  existing exact-protocol match, and an agent below it is closed with 4406 and a
  reason naming both the required and the reported version. The agent relays that
  reason to its own log, so the person on that host reads what to do rather than
  a generic "protocol mismatch" naming a number that was not the problem.
  
  **This can stop a previously working node from connecting.** An agent older
  than 0.3.0 that speaks the current protocol used to be accepted and now is not.
  Update the agent on that host (`subshell version` reports what it is running).
  
  The two gates are independent: the floor states "this server needs newer agent
  BEHAVIOUR" and moves on its own schedule, while the protocol match states "these
  two ship together". A refused agent still has its identity persisted, so it
  appears on the Nodes page with a "below minimum" badge, and Settings → Status
  lists every enrolled agent under the floor in one place — a refusal happens at
  connect, so such a node otherwise looks like an ordinary offline one.

### Patch Changes

- [`8bb0da3`](https://github.com/subshell-ai/subshell/commit/8bb0da3f1ff09d2db252de7b1475cee53c546997) Thanks [@theogravity](https://github.com/theogravity)! - Print the `/subshell` wordmark at boot, above the version line.
  
  Plain ASCII — `#` draws `/sub`, `+` draws `shell`, so the wordmark's two-tone
  split survives a journal, a piped log, or a terminal without truecolor. In a
  terminal it additionally carries the brand's own colours, read from
  `brand/src/wordmark.svg`: the slash's gradient, then `sub`, then `shell`.
  
  Colour is emitted **only when stdout is a TTY**. Under systemd or launchd it is
  not, and escape codes committed to a journal are something an operator has to
  read around forever.
  
  It reaches stdout through a LogLayer group bound to its own unprefixed
  transport, so the banner is not stamped with `[time] INFO` — which would shear
  the top row off the letterforms — without putting an unmanaged `console` writer
  back into a codebase that routes everything through LogLayer.
  
  Also fixes `bun run brand:generate`, which looked for the licensed font only at
  `~/fonts/acherus` (one maintainer's Linux layout) and so refused to run for
  anyone who had installed the family the normal way for their OS. It now
  searches the platform's real font directories, with `SUBSHELL_BRAND_FONTS_DIR`
  still overriding.

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

## 1.5.0

### Minor Changes

- [`6bc2397`](https://github.com/subshell-ai/subshell/commit/6bc2397eede9d3f6f04784ab7449c0ff486d6fd5) Thanks [@theogravity](https://github.com/theogravity)! - Several devices can now watch and drive one subshell at the same time, and the
  UI says which device is deciding its size.
  
  A tmux pane has one grid, so the server used to dodge the question by evicting
  the older viewer: opening a subshell on a laptop closed it on the phone. It now
  sizes the pane so every attached device can display all of it — the smallest
  visible viewer wins, per axis — which is a pure function of the viewer set, so
  the pane cannot bounce between two clients the way last-writer-wins did.
  
  A viewer that is not being rendered drops out of that decision. A backgrounded
  tab is not laid out at all, so it cannot re-fit until it is shown again, and
  letting a phone left open in another tab hold every laptop's terminal at phone
  size — with nothing on screen to explain it — is indistinguishable from a bug.
  It rejoins the moment it is looked at.
  
  The subshell header gains **Devices (N)**: every attached device with the grid
  it can display, which one is you, and which is holding the pane where it is
  ("sets width", "sets height"). From there the size can be pinned to one screen
  instead, and released again. Sizing is an `edit` act like typing, so a `view`
  grantee sees the list but changes nothing.

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

## 1.4.3

### Patch Changes

- [`288acab`](https://github.com/subshell-ai/subshell/commit/288acab3a766e273165f3156e583abd8e683e14a) Thanks [@theogravity](https://github.com/theogravity)! - Server bundle carries the iPad terminal fixes: two-finger touch pan and Magic Keyboard trackpad (wheel) now scroll the terminal instead of the PWA shell; grid gestures are locked against native scroll; Preferences shows the bundle build id.

## 1.4.2

### Patch Changes

- [`bce9af0`](https://github.com/subshell-ai/subshell/commit/bce9af0a8bd925084f08d345c6d1dd7a60ea8cce) Thanks [@theogravity](https://github.com/theogravity)! - fix(notify): VAPID subject defaults to the instance URL — Apple's web push refuses a localhost mailto contact (403 BadJwtToken) while FCM tolerates it, so iOS PWA pushes could never arrive on instances using the generated subject. A stored localhost subject is normalized in place on load; the key pair (and every live subscription bound to it) is untouched.

- [`24de30b`](https://github.com/subshell-ai/subshell/commit/24de30b1530c378fb322da20e524892058ce0f2a) Thanks [@theogravity](https://github.com/theogravity)! - Rolled the terminal attach path back to its last known-working state. Two fix attempts from the 2026-09-04 garble saga are reverted: the geometry reconciliation (`6351853` — the `geometry` frame, serialized/coalesced resizes, and the client's ack → re-ask → conform loop) and the quiet join (`9190c2f` — zero-overlap replay plus a CUP restoring the pane's cursor mid-screen). Each replaced a simple one-shot step with a mechanism that could keep negotiating with the pane, and the net result was worse than the state they were chasing.
  
  Kept, because both fix defects that pre-date the rollback point and neither adds a feedback loop: the replay frame still has its trailing terminator stripped, so the client's viewport stays 1:1 with the pane's rows, and a reattached pane is still repainted with a bare SIGWINCH rather than a geometry nudge that reflows scrollback. Resizes are fire-and-forget again.

- [`b4bb1bb`](https://github.com/subshell-ai/subshell/commit/b4bb1bba15a89ad557fbfb1416f38f0c1a159efe) Thanks [@theogravity](https://github.com/theogravity)! - PATCH /api/settings now audits every real `allow_registrations` flip (actor + from/to) — the toggle that opened sign-up on a live instance left no trace during the 2026-09-03 deploy-bot incident. The terminal dead-panel's Close button (frontend) is now owner-only, matching the actions menu.

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
