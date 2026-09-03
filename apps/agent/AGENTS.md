# Agent AGENTS.md

App-specific documentation for `subshell` (`@internal/agent`) — the node
daemon: it enrolls with the control plane, holds the `/ws/node` socket, and
executes signed commands (launch/tmux/fs) as the invoking user on its machine.
Design: `docs/superpowers/specs/2026-08-31-nodes-design.md` §7 + the Phase-3
distribution design beside it. Architecture-role prose: `docs/architecture.md` §9.

## Commands

```bash
bun run build            # tsdown lib build → dist/index.js|.d.ts (what turbo runs)
bun run compile          # single-file DEV binary ./dist/subshell (host only, --bytecode)
bun run compile:release  # the release pipeline (run it from ROOT as `bun run release:agent`)
bun run test             # bun test
bun run verify-types     # tsc --noEmit
```

- `compile:release` (`src/scripts/release.ts`) is deliberately SEPARATE from
  `compile`: cross builds download each target's bun runtime on first use and
  ship WITHOUT `--bytecode` (spec risk #9), so they must never become a hidden
  cost of the normal build/test path. Publish is atomic (tmp + `rename()` per
  artifact + fresh `.sha256` sidecar — the downloads route's mtime-keyed cache
  contract) and all-or-nothing (a failed target publishes NOTHING). Destination:
  `SUBSHELL_NODE_ARTIFACTS_DIR`, else `<SUBSHELL_SERVER_DATA_DIR>/node-artifacts` (a
  documented duplicate of the backend's default in `apps/backend/src/constants.ts`).
- **`turbo build` wipes the compiled `dist/subshell`** (shared `dist/` with
  the tsdown output) — re-create with `cd apps/agent && bun run compile`.
- Workspace deps (`harnesses`, `subshell-protocol`, `mcp-core`, `backend-errors`):
  the compiled binary BUNDLES their dists, so `turbo build` must run first —
  `compile:release` preflights and refuses otherwise. The agent imports
  packages, never `apps/backend` code, and never opens the app database.

## CLI (`src/cli.ts` — hand-rolled parser, no flag library)

```
subshell enroll --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>]
subshell run                       # foreground daemon (what the service unit runs)
subshell service install|uninstall # systemd user unit / launchd agent
subshell status [--json] [--probe] # lock-file truth; --probe DIALS the plane and
                                     # newest-wins KICKS a running agent — warned loudly
subshell mcp                       # stdio MCP server for a session pane (internal;
                                     # configured purely by the SUBSHELL_* pane env)
subshell version
```

`service install` refuses without an enrolled config; `service uninstall`
deliberately does NOT (a deleted config is the de-facto unenroll — an enabled
unit must stay removable). Linux: `~/.config/systemd/user/subshell.service`
(`Restart=always`) + `systemctl --user enable --now`; success prints the
linger hint (`loginctl enable-linger $USER` keeps the daemon across logout).
macOS: `~/Library/LaunchAgents/dev.subshell.agent.plist` (KeepAlive, log at
`~/Library/Logs/subshell.log`) + `launchctl bootstrap gui/<uid>`. Other
platforms: explicit refusal pointing at `subshell run` inside tmux/screen.
The unit/plist bake the installing shell's `PATH` (`Environment=PATH=` /
`EnvironmentVariables`) so a Homebrew/Nix tmux that passed the enroll preflight
is still found when the service manager — which starts units with a stock PATH —
runs the daemon; spaced paths are quoted in the systemd `ExecStart=`.
Everything is DI'd through `ServiceDeps` (`src/service.ts`) so tests pin the
exact unit/plist text and command sequences without touching systemd.

## Exit watch

The shared 2 s tick (`src/commands/report.ts`) probes each tmux socket once
via `listSessionsChecked`: an authoritative `ok:true` answer lacking the pane
reports the death IMMEDIATELY with the pane's real exit code when one is
readable (tests pin 6), while the escalated path —
`NODE_EXIT_UNREACHABLE_TICKS` (2 — ≈4 s) CONSECUTIVE
`ok:false` probes on one registration — reads `null` because the socket is not
answering, so it is THAT report that carries `exit{code:null}`; a transient
tmux blip never kills a live pane, and a fresh registration carries a fresh
counter budget (a relaunch resets it) — hardening design 2026-09-02 §1.

## On disk

- **Agent home** — `~/.config/subshell-agent`, override `SUBSHELL_AGENT_HOME` (tests
  use it): `config.json` (0600 — the nodeKey's ONLY home, never echoed by
  `status`, not even `--json`) and `daemon.lock` (local-liveness for `status`,
  refreshed on every 15 s heartbeat tick; observability only, never authority).
- **Data dir** (`--data-dir` at enroll; default under the home): `identity.json`
  (node keypair — fail-closed: a present-but-corrupt file is quarantined, never
  silently rotated), `subshells/<id>.meta.json` + `<id>.log` per supervised
  session (each meta's cwd is a `write_file` path-policy root alongside the data
  dir itself), `mcp/<id>.json`
  per-session MCP configs, and the MCP children's `identities/sess-<id>.json` +
  `peers.json` (they run with `SUBSHELL_DATA_DIR` = the agent data dir).
- **Enroll preflights `tmux`** on PATH (macOS hint: `brew install tmux`);
  `SUBSHELL_AGENT_SKIP_TMUX_CHECK=1` is the test escape hatch.

## Testing

`bunfig.toml` preloads `src/test-preload.ts`: `SUBSHELL_AGENT_HOME` points at a
throwaway temp dir (suites NEVER touch `~/.config/subshell-agent`),
`SUBSHELL_TEST_MODE=1`, and the tmux preflight is skipped (the tmux-absent refusal
is covered explicitly by clearing the var). `src/scripts/release.ts` guards its
CLI main behind `import.meta.main` so tests import the pure publish/build logic
without building or spawning; `src/service.ts` needs no such guard — it is
side-effect-free by DI design (everything arrives through `ServiceDeps`; the CLI
entry lives in `cli.ts`).
