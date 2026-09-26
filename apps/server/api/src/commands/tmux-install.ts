/**
 * Offer-to-install machinery for the tmux preflight (spec 2026-09-03): the
 * detection is a PURE table over platform + PATH facts, and execution runs
 * through an injectable sync spawn. Both properties are load-bearing — the
 * CLI lives inside the first-imported prelude (cli.ts house style: sync
 * end to end, no await, no shell), and the suites must pin the entire offer
 * flow without ever touching a package manager.
 *
 * The macOS ladder widened on 2026-09-26 (operator addendum): brew, then
 * MacPorts, then a Homebrew BOOTSTRAP offer. The old rule — "Homebrew is
 * never bootstrapped" — was a scope limit, not a safety one, and the operator
 * lifted it: installing the machine's package manager is now inside what the
 * offer may do, behind the same confirm / `--yes` semantics as every other
 * route. The bootstrap is nonetheless special, and `needsTerminal` is that
 * specialness made visible to the gates: its child is Homebrew's own
 * installer, which prompts for an admin password, so it must NEVER be
 * attempted where no password could ever be typed (a piped, terminal-less
 * run). Everywhere else the same posture holds as before: we execute only
 * fixed argvs from this table, never a shell string or env-expanded value,
 * and any password prompt goes to the child's own inherited stdio. This
 * process never reads, writes, or forwards credentials.
 *
 * The bootstrap argv embeds Homebrew's OFFICIAL installer URL on Homebrew's
 * OWN infrastructure — the exact documented one-liner from https://brew.sh.
 * That is unavoidable if the offer is to install Homebrew at all, and it is
 * NOT the retired subshell.sh one-liner hosting (this repo's spec 2026-09-15
 * §3.1, which moved OUR installers); the constant below says so at the call
 * site so nobody confuses the two. The URL is the sole external fetch, it is
 * https-pinned, and it is read from a compiled-in constant, never argv.
 */

/**
 * Homebrew's own documented install-script URL (their infra, not ours). The
 * bootstrap installer pipes THAT to `/bin/bash -c` exactly as brew.sh tells
 * a human to; nothing here is served by, or fetched from, a Subshell host.
 */
export const HOMEBREW_INSTALL_URL = "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh";

/**
 * The bootstrap's argv, built over a URL so the SHAPE is executable under
 * test (the stub server in `__tests__/tmux-install.test.ts` proves it against
 * a shebang-first script). The pipe form is not cosmetic: the reviewer
 * measured the natural-looking `bash -c "$(curl …)"` WITHOUT the outer
 * double quotes word-splitting the command substitution's result and execing
 * its first field — for any real installer script the `#!/bin/bash` line, so
 * exit 127 before anything installed. `curl … | bash` has no substitution to
 * split; the shebang arrives as a comment on bash's stdin. (The quoted-human
 * form would also work but re-introduces the quoting puzzle this way
 * cannot.)
 */
export const bootstrapArgv = (url: string): readonly string[] => ["/bin/bash", "-c", `curl -fsSL ${url} | bash`];

/** The install command for tmux on one host, plus the label the prompt shows. */
export interface TmuxInstaller {
  /** Full argv, e.g. `["brew","install","tmux"]` — run without a shell. */
  argv: readonly string[];
  /** Human label for the prompt ("brew", "MacPorts", "apt-get", "dnf", "Homebrew"). */
  label: string;
  /**
   * The manual command spelled out for the human if the offer is declined or
   * cannot run — what the plain refusal names. For the bootstrap it carries
   * the Homebrew URL (the manual route IS installing Homebrew first).
   */
  manual: string;
  /**
   * True when no run without a terminal can answer this installer's password,
   * whichever way the password gets asked: the Homebrew bootstrap's child
   * prompts for one ITSELF, and MacPorts `port install` self-escalates through
   * portsudoers (its argv carries NO parent sudo — that is why this flag, not
   * `argv[0] === "sudo"`, is what marks it). Both are refused everywhere no
   * password could ever be typed: the preflight's terminal gate and the
   * server's terminal-less route alike. brew/apt/dnf leave it false (apt/dnf
   * embed sudo in argv, which the sudo gates refuse on the route and the TTY
   * gate covers on the CLI).
   */
  needsTerminal?: boolean;
}

/**
 * Which install route fits this host, or null to fall through to the
 * status-quo refusal. The covered set (macOS, widened 2026-09-26): brew, then
 * MacPorts (`port`), then the Homebrew bootstrap when NEITHER manager is on
 * PATH — the one route allowed to install a package manager, flagged
 * `needsTerminal` so it never fires without a terminal. Linux is unchanged
 * (apt-get then dnf behind `sudo`). pacman/zypper/win32 answer null: an
 * unknown package manager is a hint, not a guess.
 */
export function chooseTmuxInstaller(io: {
  platform: NodeJS.Platform;
  which: (name: string) => string | null;
  /**
   * Overrides the bootstrap's install-script URL (test: a localhost stub).
   * Production never passes it — the compiled-in constant is the only real
   * value, which is what keeps "the URL is read from a constant, never argv"
   * true of every shipped run.
   */
  bootstrapUrl?: string;
}): TmuxInstaller | null {
  if (io.platform === "darwin") {
    if (io.which("brew")) {
      return { argv: ["brew", "install", "tmux"], label: "brew", manual: "brew install tmux" };
    }
    if (io.which("port")) {
      // MacPorts installs tmux at /opt/local/bin/tmux. `port` does NOT run
      // under a parent sudo (unlike the Linux rows, which embed it): it
      // self-escalates via portsudoers, prompting for a password when none is
      // cached — so it is flagged `needsTerminal`, the structural property the
      // preflight and the server route both gate on (review 2026-09-26: a
      // label rename must not re-admit it to a terminal-less caller). The
      // service units bake /opt/local/bin via the PATH pass-through as always.
      return {
        argv: ["port", "install", "tmux"],
        label: "MacPorts",
        manual: "sudo port install tmux",
        needsTerminal: true,
      };
    }
    // Neither manager: Homebrew's OWN documented one-liner, on Homebrew's own
    // infra (NOT our installer hosting — see the module header). The prompt
    // names it and the admin password is the child's to ask for.
    const url = io.bootstrapUrl ?? HOMEBREW_INSTALL_URL;
    return {
      argv: bootstrapArgv(url),
      label: "Homebrew",
      manual: `install Homebrew (${url}), then brew install tmux`,
      needsTerminal: true,
    };
  }
  if (io.platform === "linux") {
    if (io.which("apt-get")) {
      return { argv: ["sudo", "apt-get", "install", "-y", "tmux"], label: "apt-get", manual: "apt install tmux" };
    }
    if (io.which("dnf")) {
      return { argv: ["sudo", "dnf", "install", "-y", "tmux"], label: "dnf", manual: "dnf install tmux" };
    }
  }
  return null;
}

/**
 * Production installer runner: all three stdio streams INHERITED, so the
 * user watches brew/port/apt work and answers any sudo (or Homebrew) prompt
 * themselves. `stdin` overrides the inherited pipe — the swapped-tty run
 * passes the attached terminal's fd so the child can prompt there (a Homebrew
 * password cannot be typed into a drained curl pipe). A spawn that never
 * produced an exit code (signal-killed, unstartable) counts as failure.
 */
export function spawnInherit(argv: readonly string[], stdin: number | "inherit" = "inherit"): number {
  const res = Bun.spawnSync({ cmd: [...argv], stdout: "inherit", stderr: "inherit", stdin });
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
    /** Runner; `stdin` names the fd the child reads (default: inherit). */
    spawn: (argv: readonly string[], stdin?: number) => number;
    which: (name: string) => string | null;
    /** Where to surface a spawn that could not even start (production: the offer's log). */
    note?: (line: string) => void;
    /**
     * The terminal fd to hand the child when the process's own stdin is not
     * one (a swapped `init` read its tty onto a fresh fd, not 0). Omitted ⇒
     * inherit, which is correct for a direct TTY run.
     */
    stdin?: number;
  },
): string | null {
  let code: number;
  try {
    code = io.spawn(installer.argv, io.stdin);
  } catch (err: unknown) {
    io.note?.(`could not run '${installer.argv.join(" ")}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (code !== 0) return null;
  return io.which("tmux");
}
