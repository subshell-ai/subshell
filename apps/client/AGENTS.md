# Client AGENTS.md

App-specific documentation for `subshell` (`@internal/client`) — the node
daemon: it enrolls with the control plane, holds the `/ws/node` socket, and
executes signed commands (launch/tmux/fs) as the invoking user on its machine.
Design: `docs/superpowers/specs/2026-08-31-nodes-design.md` §7 + the Phase-3
distribution design beside it. Architecture-role prose: `docs/architecture.md` §9.

## Commands

```bash
bun run build            # tsdown lib build → dist/index.js|.d.ts (what turbo runs)
bun run compile          # single-file DEV binary ./dist/subshell (host only, --bytecode)
bun run compile:release  # the release pipeline (run it from ROOT as `bun run release:client`)
bun run test             # bun test
bun run verify-types     # tsc --noEmit
```

- `compile:release` (`src/scripts/release.ts`) is deliberately SEPARATE from
  `compile`: cross builds download each target's bun runtime on first use, so
  they must never become a hidden cost of the normal build/test path. Every
  target ships `--bytecode` (risk #9 retired at bun 1.4.0 — spec 2026-09-03
  §5); the pipeline refuses older bun. `SUBSHELL_RELEASE_TRIPLES` scopes a
  subset (CI uses this). Publish is atomic (tmp + `rename()` per
  artifact + fresh `.sha256` sidecar — the downloads route's mtime-keyed cache
  contract) and all-or-nothing (a failed target publishes NOTHING). Destination:
  `SUBSHELL_NODE_ARTIFACTS_DIR`, else `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` (a
  documented duplicate of the server's default in `apps/server/src/constants.ts`).
- **`turbo build` wipes the compiled `dist/subshell`** (shared `dist/` with
  the tsdown output) — re-create with `cd apps/client && bun run compile`.
- Workspace deps (`harnesses`, `subshell-protocol`, `mcp-core`, `backend-errors`):
  the compiled binary BUNDLES their dists, so `turbo build` must run first —
  `compile:release` preflights and refuses otherwise. The client imports
  packages, never `apps/server` code, and never opens the app database.

## CLI (`src/cli.ts` — hand-rolled parser, no flag library)

```
subshell enroll --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>] [--json]
                                   # --json prints {nodeId,serverUrl,name,dataDir,configPath}
                                   # (never the nodeKey) so a GUI need not scrape the human line
subshell run                       # foreground daemon (what the service unit runs)
subshell service install|uninstall # systemd user unit / launchd agent
subshell service status [--json]   # what the service MANAGER reports; always exits 0
subshell service start|stop|restart [--force]   # drive an installed service; never installs one
subshell status [--json] [--probe] # lock-file truth; --probe DIALS the plane and
                                     # newest-wins KICKS a running agent — warned loudly
subshell mcp                       # stdio MCP server for a subshell pane (internal;
                                     # configured purely by the SUBSHELL_* pane env)
subshell version                   # also `--version` / `-v` — aliased in the
                                     # COMMAND slot only, since argv[0] IS the
                                     # command here (`status --version` stays an
                                     # unknown flag, because it is a typo)
```

## Logging

`src/log.ts` is the agent's only log surface: **LogLayer** with the core
`ConsoleTransport` — both ship inside the `loglayer` package, so the compiled
binary takes on no third-party dependency for logging. `log(message)` is the
common call; `logger` is there for `withError()` / `withMetadata()` / levels.

Three things about it are deliberate:

- **The line format is unchanged** from the hand-rolled `console.log` it
  replaced (`[subshell <ISO>] <message>`, via `messageFn`). The daemon's stdout
  is read by whoever runs `subshell run` and by systemd/launchd, and launchd's
  log file stamps nothing itself.
- **`errorSerializer` flattens errors to plain strings.** Handing the console a
  raw `Error` makes Bun's inspector print source context, which inside a
  `--compile --bytecode` binary is the *whole minified bundle* — measured at
  ~25 KB in front of one stack trace. Four lines, no `serialize-error`
  dependency (the server can afford one; a downloaded artifact should not).
- **Tests never spy on `console`.** `__tests__/helpers/capture-logs.ts` swaps
  the TRANSPORT (`logger.withFreshTransports`), LogLayer's own seam. The old
  console spies asserted against which console method a level happens to call,
  so routing through LogLayer blinded eight tests at once — each still passing
  its setup and failing its assertion, with nothing naming the cause.

`service install` refuses without an enrolled config; `service uninstall`
deliberately does NOT (a deleted config is the de-facto unenroll — an enabled
unit must stay removable). Linux: `~/.config/systemd/user/subshell.service`
(`Restart=always`) + `systemctl --user enable --now`; success prints the
linger hint (`loginctl enable-linger $USER` keeps the daemon across logout).
macOS: `~/Library/LaunchAgents/dev.subshell.client.plist` (KeepAlive, log at
`~/Library/Logs/subshell.log`) + `launchctl bootstrap gui/<uid>`. Other
platforms: explicit refusal pointing at `subshell run` inside tmux/screen.
The unit/plist bake the installing shell's `PATH` (`Environment=PATH=` /
`EnvironmentVariables`) so a Homebrew/Nix tmux that passed the enroll preflight
is still found when the service manager — which starts units with a stock PATH —
runs the daemon; spaced paths are quoted in the systemd `ExecStart=`.
Everything is DI'd through `ServiceDeps` (`src/service.ts`) so tests pin the
exact unit/plist text and command sequences without touching systemd.

`queryService`/`controlService` (ported from `apps/server/src/service.ts`,
2026-09-05 — async here, since every seam in this module is) are what
`service status|start|stop|restart` run on. Two platform facts they encode:
the EFFECTIVE systemd `KillMode` comes from `systemctl show` (a unit-file grep
cannot see a drop-in under `subshell.service.d/`), and launchd state comes from
`launchctl print gui/<uid>/<label>` — the legacy `launchctl list` resolves an
IMPLICIT domain and reports a running gui job as absent over SSH, while every
write here targets `gui/<uid>` explicitly. Start is `bootstrap` falling back to
`kickstart -k`; restart is `kickstart -k` (a bare `kickstart` on a running job
changes nothing); stop is `bootout` (KeepAlive undoes a mere kill), and on
Linux `stop`, never `disable --now` — un-enabling is what uninstall is for.

**The pane guard is the reason those live here rather than in the caller.**
This node's subshells run their tmux servers as CHILDREN of the daemon, so a
definition lacking `KillMode=process` / `AbandonProcessGroup=true` SIGKILLs
every live pane on the machine when the daemon is stopped OR restarted. The
current templates carry both, but a host that installed an older agent has a
stale definition on disk — so `restart` REFUSES without `--force`, `stop` warns
and proceeds (refusing would only push the operator to `systemctl`, which warns
about nothing), and both fail CLOSED on an unreadable definition. `service
status` reports it as `teardown keeps panes`.

## Exit watch

The shared 2 s tick (`src/commands/report.ts`) probes each tmux socket once
via `listSubshellsChecked`: an authoritative `ok:true` answer lacking the pane
reports the death IMMEDIATELY with the pane's real exit code when one is
readable (tests pin 6), while the escalated path —
`NODE_EXIT_UNREACHABLE_TICKS` (2 — ≈4 s) CONSECUTIVE
`ok:false` probes on one registration — reads `null` because the socket is not
answering, so it is THAT report that carries `exit{code:null}`; a transient
tmux blip never kills a live pane, and a fresh registration carries a fresh
counter budget (a relaunch resets it) — hardening design 2026-09-02 §1.

## On disk

- **Config home** — `~/.config/subshell`, override `SUBSHELL_CONFIG_HOME` (tests
  use it): `config.json` (0600 — the nodeKey's ONLY home, never echoed by
  `status`, not even `--json`) and `daemon.lock` (local-liveness for `status`,
  refreshed on every 15 s heartbeat tick; observability only, never authority).
- **Data dir** (`--data-dir` at enroll; default under the home): `identity.json`
  (node keypair — fail-closed: a present-but-corrupt file is quarantined, never
  silently rotated), `allowed-dirs.json` (the pushed
  directory allowlist, 0600 — fail-OPEN on a corrupt read, deliberately unlike
  `identity.json`'s fail-closed quarantine: the list is a restriction an owner
  opts into, not an authentication decision),
  `subshells/<id>.meta.json` + `<id>.log` per supervised
  subshell (each meta's cwd is a `write_file` path-policy root alongside the data
  dir itself), `mcp/<id>.json`
  per-subshell MCP configs, and the MCP children's `identities/sess-<id>.json` +
  `peers.json` (they run with `SUBSHELL_DATA_DIR` = the client data dir).
- **Enroll preflights `tmux`** on PATH (macOS hint: `brew install tmux`);
  `SUBSHELL_CLIENT_SKIP_TMUX_CHECK=1` is the test escape hatch.

## Testing

`bunfig.toml` preloads `src/test-preload.ts`: `SUBSHELL_CONFIG_HOME` points at a
throwaway temp dir (suites NEVER touch `~/.config/subshell`),
`SUBSHELL_TEST_MODE=1`, and the tmux preflight is skipped (the tmux-absent refusal
is covered explicitly by clearing the var). `src/scripts/release.ts` guards its
CLI main behind `import.meta.main` so tests import the pure publish/build logic
without building or spawning; `src/service.ts` needs no such guard — it is
side-effect-free by DI design (everything arrives through `ServiceDeps`; the CLI
entry lives in `cli.ts`).
