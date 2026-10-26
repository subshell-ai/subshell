import { chooseTmuxInstaller, runTmuxInstall, spawnInherit } from "@/modules/server/tmux-install.js";
/** Env var that skips the tmux preflight (mirrors the agent's escape hatch). */
export const SKIP_TMUX_CHECK_ENV = "SUBSHELL_SERVER_SKIP_TMUX_CHECK";
/**
 * The offer-to-install bundle for the tmux preflight (spec 2026-09-03, gate
 * widened by the operator ruling of 2026-09-26). Three ways in:
 *
 * - `interactive`: a TTY with no `--yes` gets the y/N question, as ever;
 * - `autoAccept`: `--yes` RUNS the installer without asking — `--yes` means
 *   every question is answered yes, and the tmux install is a question like
 *   any other (the 2026-09-03 "a flag is never a system-package install"
 *   carve-out was explicitly reversed for `init`/`configure`);
 * - neither: the status-quo refusal, and when the refusal was taken on a
 *   host that DOES have an installer, `declineNotice` is one extra line
 *   naming how to get the offer back (a terminal, or `--yes`).
 *
 * `service install` passes an offer with neither `autoAccept` nor
 * `declineNotice` — it has no flags to mean yes with, so its rule stays
 * exactly the TTY-only gate of 2026-09-03.
 */
export interface TmuxOffer {
  /** Caller-computed interactivity gate: ask the question when true. */
  interactive: boolean;
  /** `--yes`: run the installer directly, without consuming a prompt. */
  autoAccept?: boolean;
  /**
   * The one line the SILENT refusal (neither interactive nor `--yes`) gains,
   * and only on a host where the auto route exists (an installer is found).
   */
  declineNotice?: string;
  /**
   * Whether a terminal exists for THIS run (direct TTY or attached) — not
   * the same fact as `interactive` (that is ask-or-not). The Homebrew
   * bootstrap, the one installer whose child prompts its own admin password,
   * may only RUN when this is true: `--yes` cannot type a password; where it
   * is false the preflight prints the bootstrap's URL instructions instead.
   * `service install` leaves it unset: its offer can only fire interactively
   * anyway, and its refusal text must stay the 2026-09-03 one.
   */
  terminal?: boolean;
  /**
   * The command's name, carried onto the refusal so the abort sentence can
   * say what to rerun once tmux exists (2026-09-26 ruling: a declined or
   * failed install ABORTS the command — nothing further is written — and the
   * message says how to come back). `service install` sets nothing; its
   * refusal stays exactly the 2026-09-03 text.
   */
  commandName?: "init" | "configure";
  /** The rerun sentence derived from {@link commandName}, if any. */
  rerunNote?: string;
  /** Where the offer's question/progress lines go (stdout in production). */
  log: (line: string) => void;
  /** The y/N question (production: `promptLineSync`); null/EOF = declined. */
  prompt: (question: string, def: string) => string | null;
  /** Installer runner (default: `spawnInherit` — inherited stdio). */
  spawn?: (argv: readonly string[], stdin?: number) => number;
  /**
   * The terminal fd to hand an installer child when this process's own stdin
   * is not a terminal — the swapped `init` run's attached tty (2026-09-26).
   * Omitted ⇒ inherit.
   */
  stdin?: number;
}
/**
 * The slice of {@link CommandDeps} the tmux preflight consumes. A named type
 * so `service install` (its own deps shape) reuses the SAME helper — the plan
 * mandates the preflight in both places, one message and one escape hatch.
 */
export interface TmuxPreflightDeps {
  /** Env source for the escape hatch (production: `process.env`). */
  env: Record<string, string | undefined>;
  /** Executable lookup (production: `Bun.which`). */
  which: (name: string) => string | null;
  /** stderr sink (the refusal lines land here). */
  error: (line: string) => void;
  /**
   * Offer-to-install bundle (absent or non-interactive ⇒ the preflight is
   * exactly its pre-offer self: refuse with the platform hint).
   */
  offer?: TmuxOffer;
  /**
   * Runtime platform for BOTH the installer detection and the hint text
   * (production: `process.platform` — the CommandDeps rule is "read nothing
   * from `process.*` directly", so it arrives here as a dep).
   */
  platform?: NodeJS.Platform;
}
/**
 * tmux preflight — the server's `local` node launches every pane through
 * tmux, so refuse `init`/`configure`/`service install` before any write when
 * it is missing. Mirrors the agent's enroll-time style: platform hint +
 * escape hatch name (spec 2026-09-03 plan-2 Global Constraints).
 *
 * Since spec 2026-09-03 (tmux offer): an interactive run with a supported
 * installer on PATH gets ONE chance to install tmux on the spot — and
 * CONTINUES the command on success (no rerun). Since the operator ruling of
 * 2026-09-26 the offer has a second way in (`--yes` runs the SAME installer,
 * no prompt — every question yes) and the macOS ladder widened (brew →
 * MacPorts → Homebrew bootstrap). Every non-success path (no offer, no
 * installer, a declined prompt, EOF, a failed install, still-not-found) now
 * ABORTS the command with nothing written further, and the refusal names the
 * declined manager's own manual command plus the rerun sentence (init/
 * configure carry one via the offer; service install keeps its 2026-09-03
 * refusal byte-identical). The ONE thing that is never attempted is the
 * Homebrew bootstrap on a run with no terminal (`needsTerminal`): its child
 * prompts an admin password that could not be typed, so it prints the
 * instructions instead of hanging on a prompt.
 *
 * @returns true when the flow may proceed (tmux present/skip var/offered install)
 */
export function tmuxPreflight(deps: TmuxPreflightDeps): boolean {
  if (deps.env[SKIP_TMUX_CHECK_ENV] === "1") return true;
  if (deps.which("tmux") !== null) return true;
  const platform = deps.platform ?? process.platform;
  const offer = deps.offer;
  // The installer lookup is needed for the declineNotice too — the terminal/
  // --yes remedy may only be promised where some installer could do it.
  const installer =
    offer !== undefined &&
    (offer.interactive ||
      offer.autoAccept === true ||
      offer.declineNotice !== undefined ||
      offer.commandName !== undefined)
      ? chooseTmuxInstaller({ platform, which: deps.which })
      : null;
  // Either needsTerminal row (Homebrew bootstrap, MacPorts self-escalation)
  // may only run where a terminal can receive its password (direct TTY or an
  // attached one). No terminal ⇒ never spawn it: print the instructions.
  const bootstrapBlocked = installer?.needsTerminal === true && offer?.terminal === false;
  if (offer && installer && !bootstrapBlocked && (offer.interactive || offer.autoAccept === true)) {
    let run: boolean;
    if (offer.autoAccept === true) {
      offer.log(`installing tmux via ${installer.label}…`);
      offer.log(`running: ${installer.argv.join(" ")}`);
      run = true;
    } else {
      offer.log(
        "tmux not found. The server launches its local subshells through tmux. " +
          `It can be installed right now with ${installer.label}.`,
      );
      offer.log(`this would run: ${installer.argv.join(" ")}`);
      const answer = offer.prompt(`Install tmux now with ${installer.label}?`, "n");
      run = answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase());
    }
    if (run) {
      // note=offer.log: an unstartable installer (bun throws ENOENT before
      // any child output) must explain itself, not fall back silently.
      const found = runTmuxInstall(installer, {
        spawn: offer.spawn ?? spawnInherit,
        which: deps.which,
        note: offer.log,
        stdin: offer.stdin,
      });
      if (found) {
        offer.log(`tmux installed (${found}), continuing.`);
        return true;
      }
      offer.log("tmux was not installed, falling back to the manual steps.");
    }
  }
  deps.error("tmux not found. The server launches its local subshells through tmux and cannot run without it.");
  const manual =
    installer?.manual ??
    (platform === "darwin"
      ? "macOS: brew install tmux"
      : platform === "linux"
        ? "Debian/Ubuntu: apt install tmux; Fedora: dnf install tmux"
        : "Linux: apt install tmux / dnf install tmux; macOS: brew install tmux");
  deps.error(`Install it first (${manual}); then rerun (escape hatch: ${SKIP_TMUX_CHECK_ENV}=1).`);
  // A declined/failed install ABORTS the command (2026-09-26 ruling). Say how
  // to come back: the manager-specific manual command is above; this names
  // the rerun. service install sets neither, keeping its old two-line refusal.
  // The message is generic over BOTH needsTerminal rows (review 2026-09-26):
  // the Homebrew bootstrap and MacPorts alike are refused here by the same
  // structural property, so it names the manager and its manual command.
  if (bootstrapBlocked && installer) {
    deps.error(
      `Installing tmux via ${installer.label} prompts for an admin password, which needs a terminal this run ` +
        `has none of; do it yourself (${installer.manual}) and rerun.`,
    );
  }
  // EXACTLY ONE remedy line (review 2026-09-26 Important 2): where a decline
  // notice actually prints (a run that could have been asked, and an
  // installer exists to honor the promise), it IS the remedy, and the rerun
  // note stays silent. Every other commandName case — an interactive decline,
  // a failed child, a host whose only installer needs a terminal — rides the
  // rerun note, which carries the abort semantics and the installed path.
  const declineRode = offer?.declineNotice !== undefined && installer !== null;
  if (offer?.commandName && !declineRode) deps.error(offer.rerunNote ?? "");
  if (declineRode && offer?.declineNotice) deps.error(offer.declineNotice);
  return false;
}
