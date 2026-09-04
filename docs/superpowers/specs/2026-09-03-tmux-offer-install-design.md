# Offer to install tmux from the CLI preflight — design

Date: 2026-09-03
Status: approved (design A)
Builds on: spec 2026-09-03 (single-binary MCP) — the `subshell-server` CLI it ships.

## Problem

`subshell-server init`/`configure`/`service install` refuse on a host without tmux
(the `local` node launches every pane through it). Today the refusal prints an
install hint and makes the user run the package-manager command themselves,
then rerun the subcommand. On a fresh Mac that is two extra steps (plus one
`brew install tmux` invocation) for a package we know is required.

## Desired behavior

When tmux is missing AND the run is interactive, offer to install it right
there and CONTINUE the flow on success — no rerun. Everything else keeps the
current refuse-with-hint behavior byte-for-byte.

## Decisions (from the design dialogue)

- **Covered install routes:** macOS `brew install tmux` (when `brew` is on
  PATH); Linux `sudo apt-get install -y tmux` / `sudo dnf install -y tmux`
  (when the package manager is on PATH). No pacman/zypper/port — anything else
  falls through to the current refusal.
- **Interactive only, never implied:** the offer appears only when
  `deps.isTTY` is true and the command is not running in the `--yes` /
  non-interactive mode the configure flow already computes. CI, scripts, and
  piped stdin see today's refusal exactly. A system-package install must never
  be the silent consequence of a flag meant to skip prompts.
- **Continue after success:** on exit 0 AND a fresh `which("tmux")` hit, the
  preflight returns true and the original command proceeds. If the installer
  exits 0 but tmux still cannot be found (PATH oddity), refuse with the normal
  hint — never continue into a deploy that will fail later.
- **Decline is the status quo:** answering `n` (or EOF at the prompt) prints
  the existing hint/refusal and exits 1. No nagging, no retry loop.

## Architecture

One new small module + a ~15-line extension of the existing choke point.

### `apps/server/src/commands/tmux-install.ts` (new)

```ts
/** What the preflight would run to install tmux on this host. */
interface TmuxInstaller {
  /** Full argv, e.g. ["brew","install","tmux"] or ["sudo","apt-get","install","-y","tmux"]. */
  argv: readonly string[];
  /** Human label for the prompt, e.g. "brew", "apt-get". */
  label: string;
}

/** Pure platform/PATH probe — which installer fits this host, or null. */
export function chooseTmuxInstaller(
  io: { platform: NodeJS.Platform; which: (name: string) => string | null },
): TmuxInstaller | null;

/**
 * Run `installer.argv` with inherited stdio (sync, per the CLI's house style)
 * and re-probe. @returns the re-probed tmux path, or null when the install
 * failed or the binary is still not findable.
 */
export function runTmuxInstall(
  installer: TmuxInstaller,
  io: { spawn: (argv: readonly string[]) => number; which: (name: string) => string | null },
): string | null;
```

`chooseTmuxInstaller` rules:
- `platform === "darwin"`: `which("brew")` → brew installer; else null.
- `platform === "linux"`: `which("apt-get")` → apt-get; else `which("dnf")` →
  dnf; else null. Both carry the `sudo` front. (Root shells still work —
  `sudo` exists on every distro we target; when it does not, the spawn fails
  loudly in the user's terminal, which is honest.)
- any other platform: null.

`runTmuxInstall` uses the injected sync spawn (production:
`Bun.spawnSync({ stdout: "inherit", stderr: "inherit", stdin: "inherit" })`
— the user watches brew/apt work and types any sudo password into sudo's own
prompt; nothing passes through this process). Success = exit 0 AND
`which("tmux")` non-null.

### `tmuxPreflight()` (configure.ts, extended)

Current order (`SKIP` env → `which` → refuse) is unchanged. After "tmux
missing", before printing the refusal:

1. `chooseTmuxInstaller` → null? refuse as today.
2. not interactive (no TTY, or the `--yes` mode flag the caller passes in)?
   refuse as today.
3. Print WHY (one line: the local node needs tmux) + the exact command about
   to run, then `prompt("Install tmux now with <label>?", "n")`.
4. Answer other than yes → refuse as today.
5. Yes → `runTmuxInstall`; found → `log("tmux installed — continuing")` and
   return true; anything else → refuse as today (the hint still shows the
   command, now with the failure visible above it).

The preflight's `TmuxPreflightDeps` gains the seams the flows already thread
through `CommandDeps`: `isTTY`, `interactive` (the `--yes` negation the
configure flow computes — passed by init/configure; `service install` passes
`!yes && isTTY`), `prompt`, `spawnSync` (default `Bun.spawnSync`-backed),
`platform` (default `process.platform`). The production `prompt` remains
`promptLineSync` — sync, first-imported-prelude-safe (entry invariant 1's
house style; the offer adds no top-level await anywhere).

### Flow diagram

```
tmuxPreflight
  SKIP=1 ──────────────────────────────► true
  which("tmux") ───────────────────────► true
  installer = chooseTmuxInstaller ─┐
  !installer ────────────► refuse (status quo)
  !interactive ──────────► refuse (status quo)
  prompt "Install now with <label>? [n]"
  declined/EOF ──────────► refuse (status quo)
  runTmuxInstall → which("tmux")
  found ─────────────────► true  (command CONTINUES)
  missing/failed ────────► refuse (status quo, failure output above the hint)
```

## Security posture

- We execute only a fixed argv (never a shell string, never env-expanded),
  chosen from a table keyed by platform + PATH facts. No dynamic imports, no
  eval.
- Passwords: sudo prompts on the user's own terminal over inherited stdio;
  this process never reads, writes, or forwards credentials.
- The offer is human-confirmed by default (`[n]`), and unreachable from
  non-interactive contexts — supply-chain surface is "the user said yes to
  their own package manager".

## Error handling

| Case | Behavior |
| --- | --- |
| Installer exits non-zero | refuse with status-quo hint; installer output already visible |
| Installer exits 0, `which("tmux")` still null | refuse with status-quo hint (PATH caveat) |
| EOF / non-yes answer | status-quo refusal |
| `spawn` throws (e.g. sudo missing mid-argv) | caught → status-quo refusal, error line surfaced |
| `SUBSHELL_SERVER_SKIP_TMUX_CHECK=1` | short-circuits before all of this (unchanged) |

## Testing

Unit (`__tests__/tmux-install.test.ts`):
- `chooseTmuxInstaller`: darwin+brew, darwin no brew, linux+apt, linux apt-
  before-dnf precedence, linux dnf-only, linux neither, other platform.
- `runTmuxInstall`: exit 0 + found → path; exit 0 + not found → null; exit
  non-zero → null; injected spawn throws → null.

Preflight (`configure.test.ts` extensions):
- missing + interactive + yes + install success → true, and no refusal text.
- missing + interactive + yes + install FAILS → false + hint.
- missing + interactive + declined → false + hint (status quo).
- missing + `--yes`/non-TTY → false + hint, `prompt` never called (the CI
  determinism guarantee).
- present tmux → true without touching installer seams (pins the happy path
  is untouched).

CLI-level: existing init/configure refusal tests stay green unchanged — the
decline path is the old path.

## Docs + versioning

- `apps/server/AGENTS.md` tmux-preflight paragraph: mention the interactive
  offer (and that `--yes`/non-TTY never triggers it).
- Changeset: `@internal/server` patch (user-visible CLI behavior).

## Explicit non-goals

- No pacman/zypper/port/macports support.
- No installing Homebrew itself (that needs its own privileged flow).
- No auto-install behind `--yes`, no new flag, no `install-tmux` subcommand.
- The CLIENT binary's tmux check (`apps/client`) keeps its current escape
  hatch + refusal; out of scope.
