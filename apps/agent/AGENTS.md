# Agent AGENTS.md

App-specific documentation for `mote-agent` (`@internal/agent`) — the node
daemon: it enrolls with the control plane, holds the `/ws/node` socket, and
executes signed commands (launch/tmux/fs) as the invoking user on its machine.
Design: `docs/superpowers/specs/2026-08-31-nodes-design.md` §7 + the Phase-3
distribution design beside it. Architecture-role prose: `docs/architecture.md` §9.

## Commands

```bash
bun run build            # tsdown lib build → dist/index.js|.d.ts (what turbo runs)
bun run compile          # single-file DEV binary ./dist/mote-agent (host only, --bytecode)
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
  `MOTE_NODE_ARTIFACTS_DIR`, else `<SESSION_DATA_DIR>/node-artifacts` (a
  documented duplicate of the backend's default in `apps/backend/src/constants.ts`).
- **`turbo build` wipes the compiled `dist/mote-agent`** (shared `dist/` with
  the tsdown output) — re-create with `cd apps/agent && bun run compile`.
- Workspace deps (`harnesses`, `session-protocol`, `mcp-core`, `backend-errors`):
  the compiled binary BUNDLES their dists, so `turbo build` must run first —
  `compile:release` preflights and refuses otherwise. The agent imports
  packages, never `apps/backend` code, and never opens the app database.

## CLI (`src/cli.ts` — hand-rolled parser, no flag library)

```
mote-agent enroll --server <url> --key <nsk_…> [--name <n>] [--data-dir <d>]
mote-agent run                       # foreground daemon (what the service unit runs)
mote-agent service install|uninstall # systemd user unit / launchd agent
mote-agent status [--json] [--probe] # lock-file truth; --probe DIALS the plane and
                                     # newest-wins KICKS a running agent — warned loudly
mote-agent mcp                       # stdio MCP server for a session pane (internal;
                                     # configured purely by the MOTE_* pane env)
mote-agent version
```

`service install` refuses without an enrolled config; `service uninstall`
deliberately does NOT (a deleted config is the de-facto unenroll — an enabled
unit must stay removable). Linux: `~/.config/systemd/user/mote-agent.service`
(`Restart=always`) + `systemctl --user enable --now`; success prints the
linger hint (`loginctl enable-linger $USER` keeps the daemon across logout).
macOS: `~/Library/LaunchAgents/dev.mote.agent.plist` (KeepAlive, log at
`~/Library/Logs/mote-agent.log`) + `launchctl bootstrap gui/<uid>`. Other
platforms: explicit refusal pointing at `mote-agent run` inside tmux/screen.
Everything is DI'd through `ServiceDeps` (`src/service.ts`) so tests pin the
exact unit/plist text and command sequences without touching systemd.

## On disk

- **Agent home** — `~/.config/mote-agent`, override `MOTE_AGENT_HOME` (tests
  use it): `config.json` (0600 — the nodeKey's ONLY home, never echoed by
  `status`, not even `--json`) and `daemon.lock` (local-liveness for `status`,
  refreshed on every 15 s heartbeat tick; observability only, never authority).
- **Data dir** (`--data-dir` at enroll; default under the home): `identity.json`
  (node keypair — fail-closed: a present-but-corrupt file is quarantined, never
  silently rotated), `sessions/<id>.meta.json` + `<id>.log` per supervised
  session (each meta's cwd is a `write_file` path-policy root alongside the data
  dir itself), `mcp/<id>.json`
  per-session MCP configs, and the MCP children's `identities/sess-<id>.json` +
  `peers.json` (they run with `MOTE_DATA_DIR` = the agent data dir).
- **Enroll preflights `tmux`** on PATH (macOS hint: `brew install tmux`);
  `MOTE_AGENT_SKIP_TMUX_CHECK=1` is the test escape hatch.

## Testing

`bunfig.toml` preloads `src/test-preload.ts`: `MOTE_AGENT_HOME` points at a
throwaway temp dir (suites NEVER touch `~/.config/mote-agent`),
`MOTE_TEST_MODE=1`, and the tmux preflight is skipped (the tmux-absent refusal
is covered explicitly by clearing the var). `src/scripts/release.ts` guards its
CLI main behind `import.meta.main` so tests import the pure publish/build logic
without building or spawning; `src/service.ts` needs no such guard — it is
side-effect-free by DI design (everything arrives through `ServiceDeps`; the CLI
entry lives in `cli.ts`).
