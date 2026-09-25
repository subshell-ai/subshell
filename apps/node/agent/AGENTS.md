# Node CLI AGENTS.md

App-specific documentation for `subshell` (`@internal/node`), the node
daemon: it enrolls with the control plane, holds the `/ws/node` socket, and
executes signed commands (launch/tmux/fs) as the invoking user on its machine.
Design: `docs/superpowers/specs/2026-08-31-nodes-design.md` §7 + the Phase-3
distribution design beside it. Architecture-role prose: the component map in
`apps/docs/content/docs/develop/architecture.mdx`; wire-level contract in
`apps/docs/content/docs/reference/node-protocol.mdx`.

**Deep-dives live in `apps/node/agent/docs/`, one file per topic.** This file
is the always-loaded half: commands, invariants, and routing lines; each
summary below says which file to read before working on that area.

## Commands

```bash
bun run build            # tsdown lib build → dist/index.js|.d.ts (what turbo runs)
bun run compile          # single-file DEV binary ./dist/subshell (host only, --bytecode)
bun run compile:release  # the release pipeline (run it from ROOT as `bun run release:cli-node`)
bun run test             # bun test
bun run verify-types     # tsc --noEmit
```

- `compile:release` (`src/scripts/release.ts`) is deliberately SEPARATE from
  `compile`: cross builds download each target's bun runtime on first use, so
  they must never become a hidden cost of the normal build/test path. Every
  target ships `--bytecode` (risk #9 retired at bun 1.4.0, spec 2026-09-03
  §5); the pipeline refuses older bun. `SUBSHELL_RELEASE_TRIPLES` scopes a
  subset (CI uses this). Each target publishes as `subshell-node-cli-<triple>`:
  the `cli` says it is the bare binary rather than the `apps/client/desktop`
  app that wraps it (`nodeArtifactFileName`, `@internal/subshell-protocol`);
  the INSTALLED binary is still `subshell`, so an install renames it. Publish
  is atomic (tmp + `rename()` per artifact + fresh `.sha256` sidecar, the
  downloads route's mtime-keyed cache contract) and all-or-nothing (a failed
  target publishes NOTHING). Destination:
  `SUBSHELL_NODE_ARTIFACTS_DIR`, else `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` (a
  documented duplicate of the server's default in `apps/server/api/src/constants.ts`).
- **`turbo build` wipes the compiled `dist/subshell`** (shared `dist/` with
  the tsdown output); re-create with `cd apps/node/agent && bun run compile`.
- Workspace deps (`pane-runtime`, `subshell-protocol`, `mcp-core`, `backend-errors`):
  the compiled binary BUNDLES their dists, so `turbo build` must run first;
  `compile:release` preflights and refuses otherwise. The client imports
  packages, never `apps/server/api` code, and never opens the app database.

## The node's name is decided HERE (revamp 2026-09-17)

The Add-node dialog's name field, the setup key's `label` column, and the
hostname guess are all gone: the question now sits where the answer is.
`setup` asks, prefilled with `os.hostname()` and validated by the plane's own
`normalizeNodeName`, and a cancel stops the whole verb (exit 1, nothing
enrolled, the single-use key unspent); `enroll` is the primitive that asks
nothing of anyone, so it requires `--name` (exit 2). A prompt needs a
terminal: under `--yes`, `--json` or a piped install, `setup` requires
`--name`, or the install one-liner passes `SUBSHELL_NODE_NAME`. `config.json`'s
`name` is a local echo of what enroll sent; the NAME is chosen at enroll, the
RENAME is the plane's (`PATCH /api/nodes/:id`). **Working on naming: read
`apps/node/agent/docs/node-name.md` first.**

## Repointing vs re-enrolling

`enroll` is not the way to change a node's address: it overwrites
`config.json`, mints a SECOND node row on the plane, spends a single-use
setup key, and discards the node key whose only home was that 0600 file.
`configure` (`src/configure.ts`) makes the two maintenance edits that keep
the SAME node: `--server` repoints, `--key` stores a rotated bearer secret in
place (and refuses an `nsk_` setup key by name). A repoint CLEARS `nodeWsUrl`
(the old plane's self-reported ws URL, which `resolveWsUrl` prefers), takes
NO `--name`, and works only between two names for ONE plane; joining a
genuinely different plane is an `enroll`. **Working on configure or
enrollment: read `apps/node/agent/docs/repointing.md` first.**

## CLI (`src/cli.ts`, hand-rolled parser, no flag library)

The verbs: `setup` (the headless entry point, what the rendered install.sh
runs), `enroll` (the primitive beneath it), `configure`, `unenroll` (always
refused while a daemon is live; `--yes` accepts ORPHANING the listed running
subshells and signals nothing), `run` (the foreground daemon the service unit
runs), `service install|uninstall|status|start|stop|restart|autostart`,
`maintenance on|off|status`, `status [--json] [--probe]` (`--probe` DIALS the
plane and newest-wins KICKS a running node), `update` (see
`apps/node/agent/docs/update.md`), `mcp` (per-pane, internal), `report`
(harness hooks: an unknown verb or kind answers a silent 0, never exit 2,
because a rejected hook blocks the pane), and `version`. There is no
`subshell plugin` command (inversion spec 2026-09-10 §6): the node holds no
plugins, and a leftover `<dataDir>/plugins/` directory is inert residue.
`status --json` carries a `paths` block so the client desktop app's reset
deletes exactly what THIS CLI names, never a path the app derived itself; the
block is read key by key, and `binary` and `agentLog` are deliberately NOT
deletion targets. **Working on a verb or its flags: read
`apps/node/agent/docs/cli.md` first.**

## Logging

`src/log.ts` is the node's only log surface: LogLayer with the core
`ConsoleTransport` plus `CappedFileTransport`, writing
`<configHome>/logs/agent.log` (JSON lines, 0600, capped at 200 KB and
REPLACED when full): the one bounded file served to the plane by
`agent_log_read`, a deliberate COPY of the server's AGPL `utils/log-file.ts`
rather than an import. Debug level is a live switch (`debug-logging.ts`,
persisted in `config.json`, forced on and made read-only by
`SUBSHELL_DEBUG_LOGGING`) that currently reveals nothing: this node has no
`logger.debug` call sites, and the console transport is never touched by any
of this. `src/log-hygiene.ts` chmods launchd's world-readable copy of the
stdout stream to 0600 at every `run` start: a repair, never a creation, and
called from `cli.ts`'s `case "run"` so no test aims it at a real
`~/Library/Logs`. **Working on logging: read
`apps/node/agent/docs/logging.md` first.**

## Service install, autostart, linger, and the manager

Linux installs `~/.config/systemd/user/subshell.service` (`Restart=always`);
macOS installs `~/Library/LaunchAgents/dev.subshell.client.plist`, and there
the plist's LOCATION is the autostart setting: `--no-autostart` writes the
same document into `<configHome>/` instead, and everything that READS a
definition (`status`, `start`, `restart`, `uninstall`, `update`) asks the
disk which of the two exists. `service install` refuses without an enrolled
config; `service uninstall` deliberately does not. `linger` is a second
question about starting (`loginctl enable-linger` gives the account a session
at BOOT, which is what a headless node needs); the fact rides
`ServiceState.linger` and `ready.runtime.service.linger`, and the macOS
`null` is the answer, not a gap. The pane guard is why all of this lives here:
this node's tmux servers are CHILDREN of the daemon, so a definition lacking
`KillMode=process` / `AbandonProcessGroup=true` SIGKILLs every live pane;
`restart` REFUSES such a (possibly stale, on-disk) definition without
`--force`, `stop` warns and proceeds, and both fail CLOSED on an unreadable
definition. **Working on service install, autostart, linger or
`queryService`/`controlService`: read `apps/node/agent/docs/service.md`
first.**

## Update (`src/update.ts`, `src/commands/update.ts`, spec 2026-09-15 §5)

Both entry points (the keyboard's `subshell update`, the plane's signed
`update` command) run one `applyUpdate`. Every install is a transaction the
NEXT process completes: the swap keeps `<binary>.previous` and writes
`update-pending.json`; the boot that follows deletes both on acceptance, or,
on a 4406 refusal, renames `.previous` back, writes `update-failed.json` and
exits 1 so the manager respawns the version that worked. That swap-back IS
the node's whole rollback; without a marker, 4406 just logs and exits. No
network path installs anything the publisher did not sign: the
`release-manifest.json` + `.sig` pair verifies against `RELEASE_PUBKEY`
before the swap, and the install digest comes from the signed `assets` map,
never the `.sha256` sidecar; `--from` and `--rollback` stay signature-free
because a file the operator named IS their decision. The `update` command's
wire shape is FROZEN across protocol bumps. **Working on update or rollback:
read `apps/node/agent/docs/update.md` first.**

## Maintenance (`src/maintenance.ts`, spec 2026-09-14)

One flag, `<dataDir>/maintenance.json` = `{ on, changedAt }`: this machine
stays enrolled and answers everything, but takes no new subshells. It is
settable from either end and reconciled on reconnect by the NEWER
`changedAt`, which is why every writer stores the stamp it was GIVEN and
never re-stamps a relay. It is its own file (a `config.json` value would not
reach a live daemon), and the read is fail-CLOSED, deliberately unlike
`allowed-dirs.json` beside it; an absent file is the third answer, and
absence travels differently: `ready` omits the field. `maintenance on` STOPS
every subshell running here. The reporting ORDER is load-bearing:
`maybeReportMaintenance` runs inside `reportDeath` BEFORE the `exit` frame.
**Working on maintenance: read `apps/node/agent/docs/maintenance.md` first.**

## Pane-log retention (`src/pane-log-retention.ts`, 2026-09-23)

Pane logs (`<dataDir>/subshells/<id>.log`, the verbatim typed transcript) age
out on this machine: one pass at boot (started before the first dial, never
awaited by it) and an hourly pass, deleting files older than `days*24h +
hours` whose pane the tmux census does not find live. The window resolves per
field (env `SUBSHELL_LOG_RETENTION_DAYS`/`_HOURS` wins, then `config.json`,
default 1 day; `0 + 0` is keep-forever and schedules nothing; the default
pass re-reads `config.json` every run, which is what lets a dashboard write
land without a restart). A running pane's log is never swept and a probe that
THROWS counts the pane running (unknown is not dead); only
`<valid-id>.log` names inside the data dir are eligible. The setter surface is
node-local (`GET`/`PUT /api/self/log-retention` on the loopback dashboard;
the plane has no counterpart route). **Working on retention: read
`apps/node/agent/docs/pane-log-retention.md` first.**

## The loopback dashboard (`src/dashboard/`, spec 2026-09-19)

`subshell run` binds **127.0.0.1:3090** and serves the node its own admin
page (Status, Node Settings, Updates) under the control plane's verbatim
`/api/nodes/:id/*` contract, so the cards in `@internal/node-admin` run
untouched against either backend. There is no login: the listen address plus
the OS user IS the access control, and the load-bearing guards and their full
accounting are `.claude/rules/security-context.md` (§Nodes) and
`docs/security.md` §6, not this file. A busy port costs the dashboard and
never the daemon; mutations reuse the command executors, so the supervision
and pane-safety refusals and the signed-update verification are ONE
implementation with the plane-driven path; pages come disk → embedded →
notice. **Working on the dashboard: read
`apps/node/agent/docs/dashboard.md` first.**

## What `ready` reports about this process (`src/runtime.ts`)

`ready.runtime` (spec 2026-09-12 §6.1) answers "how is this node running":
supervised or not, the manager's view of the unit, the config and log paths,
tmux, and the binary this process re-enters. `collectRuntime` builds it ONCE,
before the connect loop, from one `service status` spawn.

**Once, and then frozen: the same object is resent on every reconnect.** That
is what lets the control plane compare `startedAt` for EQUALITY rather than
against a tolerance, and the SPA's restart waiter has no other signal: a node
that goes offline and comes back is only distinguishable from a flapping socket
by that field changing. Re-deriving the report per connection would make a
reconnect look like a restart, and the wait would end early with nothing
naming the cause. Collecting per process is also honest on its own terms:
nothing in the report can change while the pid does not.

A failed read degrades to no `runtime` at all rather than a null-filled one:
the field is optional on the wire, and the plane shows no card. `parseNodeEvent`
drops a malformed one and keeps the `ready`, so a wrong report costs the card
and never the connection.

## `service` (`src/commands/service.ts`)

The plane-sent `{ type: "service", verb }` drives this machine's service
manager: `start`, `stop`, `restart`, `install`, `uninstall`. Through protocol
4 `restart` was its own command; folding it in removed a second refusal path
and a second chance to disagree about pane safety.

**`restart` is not `systemctl restart`.** It exits 0 and lets the manager
respawn the node: asking systemd to restart the unit from inside that unit
kills the process mid-command, so the result frame never goes out and the plane
sees a dropped socket instead of an answer. Every other verb is a real call to
the manager, through the same `controlService`/`installService` the CLI uses.

**Two of the five are one-way from the plane, and nothing here can soften
that.** A command arrives over the node's OWN socket, so `stop` and
`uninstall` end the connection that would have carried the verb undoing them;
the plane can never start a node that is not running. The PLANE gates those
two on ownership and says so in its confirmation; this side simply performs
them.

Three things about `restart` are load-bearing:

- **The `result` frame goes out FIRST, and the exit is 250 ms later.** The
  daemon is the only sender of `result`, so an executor that exited itself
  would reach the plane as a TIMEOUT rather than a success: the restart would
  have worked and the UI would say it failed. The executor therefore returns
  `{ ok: true }` and asks the daemon to exit (`CommandContext.requestRestart`).
- **It refuses when `runtime.supervised` is false**, which means the manager did
  not start this pid: exiting would be a stop, not a restart. A foreground
  `subshell run` is the common case.
- **`paneSafety: "unknown"` refuses with `"kills"`, not with `"keeps"`.** Same
  fail-closed rule the CLI's own destructive verbs use (an unreadable
  definition is not evidence of safety), and `force: true` is the only way past
  either. That refusal is not restart's alone: `stop` and `uninstall` end the
  same panes, so all three destructive verbs carry it and `start`/`install`
  never can.

The exit takes the SIGINT/SIGTERM path verbatim (set `shuttingDown`, close the
socket 1000, let the loop's `stop(0)` run), so `daemon.lock` is cleared by the
one exit path that has ever cleared it.

## Exit watch

**The watcher is the BACKSTOP now, not the primary.** Since spec 2026-09-19
every pane carries a tmux `pane-died` hook that reports its own death straight
to the control plane (measured at 0.3 s on a live node, against this tick's
2 s), so what reaches the watcher is the deaths a hook cannot report: a
SIGKILLed tmux server, a machine that lost power, a launch with no resolved
reporter. Measured too: with tmux SIGKILLed the watcher still reports in 3.6 s
(two ticks), which is the case it exists for.

**The liveness probe's format is COLON-separated, and that is load-bearing
across tmux versions.** `listSubshellsChecked` asks for
`#{session_name}:#{pane_dead}`; with a TAB it worked on tmux 3.7 and was
silently mangled on **3.4** (Ubuntu 24.04's and Debian's tmux, so most Linux
nodes), which renders the tab in `-F` output as `_`. Every field then parsed
as one: names came back as `live1_0`, so no subshell id ever matched, and the
deadness flag was absent, so a finished pane read as alive. On such a host
this watcher would have reported EVERY running subshell dead seconds after
launch while never reporting a real death. Caught by CI, which runs 3.4; no
local tmux could see it. `parseSessionLiveness` is pure and exported so the
half that CAN be checked everywhere is driven with output captured from both
versions.

**And "lacking the pane" no longer means the session vanished.** Panes are
launched with `remain-on-exit`, so a finished pane's SESSION survives; what
keeps this contract true is that `listSubshellsChecked` filters on
`#{pane_dead}` and returns LIVE panes only. That filter lives in
`@internal/pane-runtime`, not here, and removing it would mean no node-run
subshell was ever reported dead again while every test in this package still
passed. Its own test is mutation-checked for that reason.

**The hook is built from the pane's EFFECTIVE env**, through
`paneEnvFor` in `@internal/pane-runtime`, the one place the precedence
`subshellEnv < preset.env < mcpEnv` is stated, and the same call the pane
command itself is assembled from. Both ends used to compute it from a
different SLICE of those layers (this one omitted the preset's, the control
plane omitted the MCP wiring), so a preset that legitimately overrode
`SUBSHELL_BASE_URL` moved the pane and not its death report.

**And the node reaps the server it kept alive.** `remain-on-exit` is what
makes a finished pane observable, and the price is that tmux no longer tears
itself down: one idle server per dead subshell, each holding the whole of its
pane's scrollback, accumulating for the life of the machine. `reportDeath`
kills the session after reading the exit code and sending the frame, inside
the same relaunch re-check that guards the tails drop. Here rather than on the
plane: the plane reaps its own panes and deliberately skips node rows (that
server belongs to this machine), and doing it here also works while the plane
is unreachable, which is exactly when deaths pile up.

The shared 2 s tick (`src/commands/report.ts`) probes each tmux socket once
via `listSubshellsChecked`: an authoritative `ok:true` answer lacking the pane
reports the death IMMEDIATELY with the pane's real exit code when one is
readable (tests pin 6), while the escalated path,
`NODE_EXIT_UNREACHABLE_TICKS` (2, ≈4 s) CONSECUTIVE
`ok:false` probes on one registration, reads `null` because the socket is not
answering, so it is THAT report that carries `exit{code:null}`; a transient
tmux blip never kills a live pane, and a fresh registration carries a fresh
counter budget (a relaunch resets it), hardening design 2026-09-02 §1.

## On disk

- **Config home**, `~/.config/subshell`, override `SUBSHELL_CONFIG_HOME` (tests
  use it): `config.json` (0600: the nodeKey's ONLY home, never echoed by
  `status`, not even `--json`) and `daemon.lock` (local-liveness for `status`,
  refreshed on every 15 s heartbeat tick; observability only, never authority).
- **Data dir** (`--data-dir` at enroll; default under the home): `identity.json`
  (node keypair; fail-closed: a present-but-corrupt file is quarantined, never
  silently rotated), `allowed-dirs.json` (the pushed
  directory allowlist, 0600; fail-OPEN on a corrupt read, deliberately unlike
  `identity.json`'s fail-closed quarantine: the list is a restriction an owner
  opts into, not an authentication decision), `maintenance.json`
  (`{ on, changedAt }`, 0600, atomic temp+rename, read fail-CLOSED; see
  `apps/node/agent/docs/maintenance.md`),
  `update-pending.json` / `update-failed.json` (0600, the update transaction's
  markers; see `apps/node/agent/docs/update.md`; `failed` survives until the next update, so the
  reason is still on screen an hour later),
  `subshells/<id>.meta.json` + `<id>.log` per supervised
  subshell (each meta's cwd is a `write_file` path-policy root alongside the data
  dir itself), `mcp/<id>.json`
  per-subshell MCP configs, and the MCP children's `identities/sess-<id>.json` +
  `peers.json` (they run with `SUBSHELL_DATA_DIR` = the node's data dir).
- **The `<id>.log` capture child is the agent's OWN `pane-log` verb**, not
  `cat`: `launch.ts` calls `pipePane(…, selfInvocation("pane-log"))`, and
  `cli.ts`'s pre-boot `pane-log --file <path>` runs
  `@internal/pane-runtime`'s `appendStdinToLogFile` (an unbuffered
  `readSync`→`writeSync` copy that opens 0600). A bare `cat >>` froze the
  browser's live view on hosts whose `cat` is uutils coreutils: it buffers a
  partial write to a regular file, so a keystroke echo never reached the log
  until an Enter-sized burst flushed it (the exit-hook re-entry above uses the
  same `selfInvocation` for `report`). Full accounting: `docs/security.md`,
  "Pane logs".
- **Enroll preflights `tmux`** on PATH (macOS hint: `brew install tmux`);
  `SUBSHELL_CLIENT_SKIP_TMUX_CHECK=1` is the test escape hatch.

## Testing

`bunfig.toml` preloads `src/test-preload.ts`: `SUBSHELL_CONFIG_HOME` points at a
throwaway temp dir (suites NEVER touch `~/.config/subshell`),
`SUBSHELL_TEST_MODE=1`, and the tmux preflight is skipped (the tmux-absent refusal
is covered explicitly by clearing the var). `src/scripts/release.ts` guards its
CLI main behind `import.meta.main` so tests import the pure publish/build logic
without building or spawning; `src/service.ts` needs no such guard: it is
side-effect-free by DI design (everything arrives through `ServiceDeps`; the CLI
entry lives in `cli.ts`).
