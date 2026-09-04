/**
 * Offer-to-install machinery for the tmux preflight (spec 2026-09-03): the
 * detection is a PURE table over platform + PATH facts, and execution runs
 * through an injectable sync spawn. Both properties are load-bearing — the
 * CLI lives inside the first-imported prelude (cli.ts house style: sync
 * end to end, no await, no shell), and the suites must pin the entire offer
 * flow without ever touching a package manager.
 *
 * Security posture: we execute only fixed argvs from this table (never a
 * shell string, never env-expanded). Any sudo password goes to sudo's own
 * prompt in the user's terminal over inherited stdio — this process never
 * reads, writes, or forwards credentials.
 */

/** The install command for tmux on one host, plus the label the prompt shows. */
export interface TmuxInstaller {
  /** Full argv, e.g. `["brew","install","tmux"]` — run without a shell. */
  argv: readonly string[];
  /** Human label for the prompt ("brew", "apt-get", "dnf"). */
  label: string;
}

/**
 * Which install route fits this host, or null to fall through to the
 * status-quo refusal. The covered set is deliberate (spec decisions): brew
 * on macOS (Homebrew itself is never bootstrapped here), apt-get then dnf
 * on Linux behind `sudo`. Everything else — pacman, zypper, port, win32 —
 * answers null: an unknown package manager is a hint, not a guess.
 */
export function chooseTmuxInstaller(io: {
  platform: NodeJS.Platform;
  which: (name: string) => string | null;
}): TmuxInstaller | null {
  if (io.platform === "darwin") {
    return io.which("brew") ? { argv: ["brew", "install", "tmux"], label: "brew" } : null;
  }
  if (io.platform === "linux") {
    if (io.which("apt-get")) return { argv: ["sudo", "apt-get", "install", "-y", "tmux"], label: "apt-get" };
    if (io.which("dnf")) return { argv: ["sudo", "dnf", "install", "-y", "tmux"], label: "dnf" };
  }
  return null;
}

/**
 * Production installer runner: all three stdio streams INHERITED, so the
 * user watches brew/apt work and answers any sudo prompt themselves.
 * A spawn that never produced an exit code (signal-killed, unstartable)
 * counts as failure.
 */
export function spawnInherit(argv: readonly string[]): number {
  const res = Bun.spawnSync({ cmd: [...argv], stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return res.exitCode ?? 1;
}

/**
 * Run the installer, then RE-PROBE: success is exit 0 AND tmux now findable.
 * The re-probe is the guard against the PATH caveat (brew installed into a
 * directory this process cannot yet see) — continuing on a blind exit code
 * would build a deploy that fails at the first pane.
 *
 * A throw is surfaced through `note`, NOT silence: measured on bun 1.4.0,
 * `Bun.spawnSync` throws ENOENT for an unstartable argv BEFORE any child
 * output, so without the note the user who typed `y` would see nothing
 * explain the fall-back (the sudo-less-container case: apt-get on PATH, no
 * sudo binary). Non-zero exits need no note — the installer printed its own
 * failure to the inherited stderr.
 * @returns the tmux path, or null (install failed, threw, or still missing)
 */
export function runTmuxInstall(
  installer: TmuxInstaller,
  io: {
    spawn: (argv: readonly string[]) => number;
    which: (name: string) => string | null;
    /** Where to surface a spawn that could not even start (production: the offer's log). */
    note?: (line: string) => void;
  },
): string | null {
  let code: number;
  try {
    code = io.spawn(installer.argv);
  } catch (err: unknown) {
    io.note?.(`could not run '${installer.argv.join(" ")}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (code !== 0) return null;
  return io.which("tmux");
}
