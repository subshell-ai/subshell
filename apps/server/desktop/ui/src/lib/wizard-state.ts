/**
 * The assistant's decisions, pure (spec 2026-09-11 § 5, § 8.1; spec
 * 2026-09-12 § 5.3).
 *
 * Which screens exist for THIS machine, where the dots stand, which
 * checklist rows are ticked, whether Set Up may be pressed and why not, which
 * of the CLI's words go under a failed row, and — since the console window
 * went — what the one recovery screen is called and what its single action
 * does. Page state (the current screen, running, the last result) stays in
 * wizard.ts; only facts a probe licenses live here, so a reopen after a quit
 * or a CLI-driven half-setup renders honestly.
 */
import type { ActionResult, Probe, ProbeStep } from "./ipc";

/**
 * Every screen this window can show.
 *
 * The first three are the first run, in order (`tmux` exists only while tmux
 * is missing). The last three are not a journey: `recovery` is what a machine
 * that has been set up sees while its server is not answering, and `update`
 * and `reset` are entered by REQUEST — a `desktop-screen` event from the SPA,
 * or the recovery footer — over whatever is showing.
 */
export type ScreenId = "welcome" | "tmux" | "setup" | "recovery" | "update" | "reset";

/** The first-run trio, which is also every position a dot can take. */
const FIRST_RUN: readonly ScreenId[] = ["welcome", "tmux", "setup"];

/**
 * The label on the way into the Reset screen, and the Reset screen's own
 * title. One string, because a button and the screen it opens disagreeing
 * about what they are for is its own small betrayal.
 *
 * It was `Reset ${here()}…`, which rendered "Reset this Mac…" and was wrong
 * twice over (operator report from a screenshot, 2026-09-12).
 *
 * It OVERCLAIMED. "Reset this Mac" is a sentence that means erase the
 * computer. This stops and uninstalls one service and deletes one instance's
 * data. A destructive label that is frightening about the wrong thing is
 * worse than one that is frightening, because it teaches people that these
 * labels do not mean what they say — and the next one they disbelieve will be
 * accurate.
 *
 * And it read as TRUNCATED: "Mac" is a prefix of "Machine", the sibling
 * string on Linux really is "this machine", and the label ended there under
 * the ellipsis a button that opens a screen carries. Nothing told the eye
 * whether the word had finished, which is how it was reported — as a layout
 * bug.
 *
 * **Deliberately NOT "Reset Subshell", which is Subshell Client's string for
 * its own twin of this screen.** The two apps install side by side, and their
 * resets destroy different things: the client's takes a node's config, its
 * key and its data directory, while this one takes the control plane —
 * including the database that holds every user, every API key and the node
 * signing keypair that rules every enrolled machine. One label over two acts
 * of different severity is exactly the overloading the project's vocabulary
 * rule exists to prevent.
 *
 * It names the PRODUCT rather than either machine (operator's call,
 * 2026-09-12), and no platform word appears: everything this app does is on
 * this machine, so saying so was only ever redundant. Subshell Client's reset
 * title is this same string, which is the point — one act, one name, in both
 * apps.
 */
export const RESET_LABEL = "Reset Subshell";

/**
 * The title of the Set Up screen, on BOTH paths to it: the first run, and a
 * recovery on a machine that was set up once and later lost its server
 * binary. One act must not have two names, and it had two — "Set Up Your
 * Server" here and "Set Up Subshell on this Mac" there.
 *
 * It names the product (operator's call, 2026-09-12). No platform word: the
 * conversational "on this Mac" belongs in the SUBTITLE, which still carries
 * it, so the macOS voice survives where it reads as voice rather than as a
 * label that might have been cut off.
 */
export const SETUP_TITLE = "Set Up Subshell Server";

/** How the tmux screen presents itself when missing. */
export type PrereqState = "found" | "install" | "manual";

/** Where the press installs the server; rendered as a constant, resolved for real in Rust. */
const INSTALL_PATH = "~/.local/bin/subshell-server";

export function prereqState(probe: Probe): PrereqState {
  if (probe.tmux) return "found";
  if (probe.platform === "darwin") return probe.hasBrew ? "install" : "manual";
  return "install";
}

/**
 * The screens this machine will see (spec 2026-09-12 § 5.3).
 *
 * Before setup has ever completed: the first-run trio, minus any screen with
 * nothing to ask (tmux, when there already is one). After: the ONE recovery
 * screen while the server is not ready, and nothing at all when it is — the
 * page opens the dashboard and this window steps back.
 *
 * A `ready` probe empties the list whichever family the machine is in,
 * because that is the same moment in both: the dashboard is what comes next,
 * and a screen list with anything in it would render behind it.
 *
 * `update` and `reset` are never in the list. They are entered by request,
 * which is what lets them appear over a first run as readily as over a
 * recovery without either family having to name them.
 */
export const REQUESTED_SCREENS: readonly ScreenId[] = ["update", "reset"];

/**
 * Whether this screen was asked for rather than implied by the probe.
 *
 * The page must let a requested screen OUTRANK an empty {@link screensFor},
 * and that is not a nicety: an empty list means "ready", which the page reads
 * as "open the dashboard and step this window back". Both requested screens
 * render over a ready machine by definition — Update deep-links onto a running
 * server, and Reset is asked for from that server's own dashboard — so without
 * this the window closes itself the moment the probe answers.
 *
 * Measured on 2026-09-12: pressing "Reset this machine" opened the assistant,
 * which said "Opening your dashboard…" and vanished. The page had this rule
 * for `update` alone, written at its one call site, so `reset` never got it.
 */
export function isRequestedScreen(screen: ScreenId | null): boolean {
  return screen !== null && REQUESTED_SCREENS.includes(screen);
}

export function screensFor(probe: Probe, onboarded: boolean): ScreenId[] {
  if (probe.next === "ready") return [];
  if (!onboarded) return FIRST_RUN.filter((s) => s !== "tmux" || probe.tmux === null);
  return ["recovery"];
}

/**
 * The recovery screen's title, which is the STEP's title: one screen whose
 * whole content is what this machine's server needs, so the heading is the
 * diagnosis rather than a fixed word with the diagnosis beneath it.
 *
 * `platform` reaches only the two steps that name where you are. "this Mac"
 * on darwin and "this machine" elsewhere is the house rule, and it is here
 * rather than at the call site so both surfaces that render a title cannot
 * disagree about it.
 */
export function recoveryTitle(step: ProbeStep): string {
  switch (step) {
    case "no-server":
      return "No Server Found";
    case "unreachable":
      return "Your Server Isn't Responding";
    case "init":
      return "Your Server Needs Its Configuration";
    case "install-service":
      return "Your Server Isn't Installed as a Service";
    case "start":
      return "Your Server Is Stopped";
    case "setup":
      // The SAME string the first-run setup screen uses, and it names the
      // product rather than the machine (operator's call, 2026-09-12). One
      // act reached two ways — first run, and a recovery on a machine that
      // lost its server binary — must not have two names. No platform word:
      // every other title in this file already names the server, and the
      // conversational "on this Mac" lives in the SUBTITLES, which is where
      // the macOS voice belongs.
      return SETUP_TITLE;
    case "ready":
      return "Opening Your Dashboard…";
  }
}

/** What the recovery screen's one button DOES, as a closed set the page branches on. */
export type RecoveryActionKind = "choose-binary" | "retry" | "setup" | "install-service" | "start";

/**
 * The single primary action for a step, or `null` when there is nothing left
 * to press.
 *
 * One per screen, deliberately: the console offered a row of them and the row
 * was the reason a person had to decide which of three buttons matched their
 * situation, on a screen that already knew. `init` and `setup` share an
 * action because they share a chain — `desktop_setup` writes the
 * configuration either way, and the install step is a no-op where a binary is
 * already present.
 */
export function recoveryAction(step: ProbeStep): { label: string; kind: RecoveryActionKind } | null {
  switch (step) {
    case "no-server":
      return { label: "Choose subshell-server…", kind: "choose-binary" };
    case "unreachable":
      return { label: "Retry", kind: "retry" };
    case "init":
    case "setup":
      return { label: "Set Up", kind: "setup" };
    case "install-service":
      return { label: "Install and Start", kind: "install-service" };
    case "start":
      return { label: "Start", kind: "start" };
    case "ready":
      return null;
  }
}

/**
 * Dot semantics: six positions always, not three. The SPA's three /setup
 * screens (Account, Agent, Launch) always follow the native ones on a
 * desktop first run — the wizard only ever opens before setup completes, and
 * a fresh instance always lands on `/setup` — so a three-dot row would grow
 * to six the moment the SPA takes over, which is exactly the handoff this
 * one shared frame exists to hide. Rendering six from the start means the
 * row's WIDTH never changes at the swap, only which dots are filled. A
 * machine that skips the tmux screen sees its dot already filled rather than
 * a shorter row.
 *
 * `_probe` is unused now that the total is fixed at six and `done`/`current`
 * derive from `current`'s index alone. Kept for signature stability (call
 * sites, and parity with the other pure functions here that all take a
 * `Probe`) rather than dropped — deliberately, not an oversight.
 *
 * Recovery, Update and Reset are not on this journey, so they have no
 * position: `indexOf` answers -1 for them and the renderer hides the row on a
 * negative `current`. That falls out of the lookup rather than being a branch
 * — there is one list of dot positions, and a screen is either on it or it is
 * not.
 */
export function dots(_probe: Probe, current: ScreenId): { total: 6; done: number; current: number } {
  const index = FIRST_RUN.indexOf(current);
  return { total: 6, done: index, current: index };
}

export type SetupRowId = "tmux" | "server" | "config" | "service" | "running";

export interface SetupRow {
  id: SetupRowId;
  label: string;
  /** Muted right-hand text: a path, the addresses, or what "done" will mean. */
  detail: string;
  done: boolean;
}

/**
 * The Setting Up checklist, ticked from probe facts and never from the
 * chain's progress (optimism ticks a row the CLI then refuses). `addresses`
 * are the Customize form's current values, empty when untouched.
 */
export function setupRows(probe: Probe, addresses: { port: string; host: string }): SetupRow[] {
  const port = addresses.port || "3080";
  const host = addresses.host === "" || addresses.host === "0.0.0.0" ? "all interfaces" : addresses.host;
  return [
    { id: "tmux", label: "tmux", detail: probe.tmux ?? "", done: probe.tmux !== null },
    { id: "server", label: "Server", detail: probe.server?.argv[0] ?? INSTALL_PATH, done: probe.server !== null },
    {
      id: "config",
      label: "Configuration",
      detail: `port ${port}, ${host}`,
      done: probe.status?.configEnv?.exists === true,
    },
    { id: "service", label: "Background service", detail: "starts at login", done: probe.service?.installed === true },
    { id: "running", label: "Running", detail: "", done: probe.next === "ready" },
  ];
}

/**
 * Whether Set Up is live, and the reason beside it when not. An empty reason
 * means busy: a spinner is already on screen. The only machine gate is tmux
 * (`init` and `service install` both refuse without it); a missing server is
 * the chain's own first act.
 */
export function canSetup(probe: Probe | null, busy: boolean): { ok: true } | { ok: false; reason: string } {
  if (probe === null) return { ok: false, reason: "Checking this machine…" };
  if (busy) return { ok: false, reason: "" };
  if (probe.tmux === null) return { ok: false, reason: "Waiting for tmux" };
  return { ok: true };
}

/** The one line under a failed row: the CLI's last word on stderr, else stdout's, else a fixed sentence. */
export function failureLine(result: ActionResult): string {
  const last = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
  return last(result.stderr) ?? last(result.stdout) ?? "Setup stopped.";
}
