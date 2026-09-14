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
export type ScreenId = "welcome" | "tmux" | "setup" | "recovery" | "update" | "reset" | "supervision";

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
 * **The two apps do NOT share a string**, and that is the whole point. They
 * install side by side, and their resets destroy different things: the client's takes a node's config, its
 * key and its data directory, while this one takes the control plane —
 * including the database that holds every user, every API key and the node
 * signing keypair that rules every enrolled machine. One label over two acts
 * of different severity is exactly the overloading the project's vocabulary
 * rule exists to prevent.
 *
 * So it names WHAT IS RESET (operator's call, 2026-09-12): this server. The
 * two apps say different things because they destroy different things, and
 * Subshell Client's twin reads "Reset this client" for the same reason.
 *
 * It briefly read "Reset Subshell" in both, which contradicted the paragraph
 * above it: one label over two acts of different severity is the overloading
 * the vocabulary rule exists to prevent, and the product name is the one word
 * that cannot tell them apart. No platform word appears in either — everything
 * either app does is on the machine it is running on, so saying so was only
 * ever redundant, and "this Mac" was what made the old label read as truncated.
 */
export const RESET_LABEL = "Reset this server";

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
export const REQUESTED_SCREENS: readonly ScreenId[] = ["update", "reset", "supervision"];

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
 * Measured on 2026-09-12: pressing the dashboard's reset button opened the assistant,
 * which said "Opening your dashboard…" and vanished. The page had this rule
 * for `update` alone, written at its one call site, so `reset` never got it.
 */
/**
 * The screen a `desktop-screen` payload names, or `null` for "whatever the
 * probe implies".
 *
 * **Derived from {@link REQUESTED_SCREENS}, never re-listed.** The page used
 * to write this decision inline as `payload === "update" ? "update" : null`,
 * and the cost of that was measured three times: `reset` was dropped when it
 * was added, `supervision` was dropped when IT was added, and each time the
 * symptom was the same — the assistant raises, matches nothing, and bounces
 * the user straight back to the dashboard they pressed the button on. A
 * screen added to the closed Rust enum and to `REQUESTED_SCREENS` now routes
 * with no third edit to forget.
 *
 * `reset` is in the set and answers here like the others; the caller still
 * handles it specially because it has a plan to arm first.
 */
export function screenForRequest(payload: string): ScreenId | null {
  return (REQUESTED_SCREENS as readonly string[]).includes(payload) ? (payload as ScreenId) : null;
}

export function isRequestedScreen(screen: ScreenId | null): boolean {
  return screen !== null && REQUESTED_SCREENS.includes(screen);
}

export function screensFor(probe: Probe, onboarded: boolean): ScreenId[] {
  if (probe.next === "ready") return [];
  // The tmux screen is shown on EVERY first run, including machines that
  // already have it. It used to be filtered out when `probe.tmux` was set,
  // and the skip was invisible in the worst way: `dots` positions by
  // `FIRST_RUN.indexOf`, so the flow went from dot 1 to dot 3 with nothing
  // saying why, and a prerequisite the product depends on was satisfied
  // without ever being named. It costs a machine that has tmux one press of
  // Continue, and buys a flow that is the same length everywhere and a
  // dependency the person has actually been told about.
  if (!onboarded) return [...FIRST_RUN];
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
/**
 * What the setup press was asked to do about supervision.
 *
 * Defaulted so every existing caller and test keeps its meaning: a background
 * service that starts at login is what this chain has always done.
 */
export interface SupervisionChoice {
  /** Register a launchd agent / systemd unit, rather than running it here. */
  background: boolean;
  /** Arm that service for login. Meaningless, and forced false, without the above. */
  autostart: boolean;
}

export const DEFAULT_SUPERVISION: SupervisionChoice = { background: true, autostart: true };

export function setupRows(
  probe: Probe,
  addresses: { port: string; host: string },
  choice: SupervisionChoice = DEFAULT_SUPERVISION,
): SetupRow[] {
  const port = addresses.port || "3080";
  const host = addresses.host === "" || addresses.host === "0.0.0.0" ? "all interfaces" : addresses.host;
  // The fourth row is about a different THING in each mode, so its label
  // changes with it: a checklist row reading "Background service" while the
  // chain deliberately installs none would be the progress display lying
  // about the plan the person just approved.
  const supervision: SetupRow = choice.background
    ? {
        id: "service",
        label: "Background service",
        detail: choice.autostart ? "starts at login" : "not at login",
        done: probe.service?.installed === true,
      }
    : {
        id: "service",
        label: "Runs with this app",
        detail: "stops when you quit",
        done: probe.supervision === "app" && probe.supervisor?.pid != null,
      };
  return [
    { id: "tmux", label: "tmux", detail: probe.tmux ?? "", done: probe.tmux !== null },
    { id: "server", label: "Server", detail: probe.server?.argv[0] ?? INSTALL_PATH, done: probe.server !== null },
    {
      id: "config",
      label: "Configuration",
      detail: `port ${port}, ${host}`,
      done: probe.status?.configEnv?.exists === true,
    },
    supervision,
    { id: "running", label: "Running", detail: "", done: probe.next === "ready" },
  ];
}

/**
 * The first `subshell-server` that understands `service enable|disable` and
 * `service install --no-autostart` — i.e. the version this shipped in.
 *
 * The app may be driving an OLDER installed server: the ladder adopts a newer
 * installed copy, and a machine set up before this release has one. Offering
 * a login choice such a server will refuse would be a checkbox that silently
 * does nothing, so the surfaces that depend on those verbs say why instead.
 *
 * No GitHub release of the server has carried the verbs yet (the last cut was
 * `server-v0.2.0`; 0.3.0 and 0.4.0 were npm-only version bumps), so this names
 * the release that WILL: 0.5.0, the next server minor. The test beside it
 * (`wizard-state.test.ts`) turns red the moment a server bump moves past it.
 */
export const MIN_AUTOSTART_SERVER_VERSION = "0.5.0";

/** Whether the resolved server is new enough to control start-at-login. */
export function autostartSupported(probe: Probe): boolean {
  const found = probe.server?.version;
  // Unknown version: assume capable rather than disable a working control on
  // a version string we simply could not parse. The CLI's own refusal is the
  // backstop, and it arrives with the manager's words.
  if (!found) return true;
  return !isOlder(found, MIN_AUTOSTART_SERVER_VERSION);
}

/** Numeric semver compare — `1.10.0` is newer than `1.9.0`, which a string compare denies. */
function isOlder(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * The two boxes, as one value with the dependency between them enforced.
 *
 * "Start it at every login" is meaningless without a service to start, so
 * unchecking the first forces the second off AND disables it. Re-checking the
 * first restores the DEFAULT rather than a remembered value: the box was
 * disabled, not chosen, and treating a forced-off state as a preference would
 * silently opt someone out of login on a press they never made.
 */
/**
 * Why the start-at-login control is unavailable, or `null` when it is usable.
 *
 * The mirror of the dashboard's `lib/supervision.ts` `loginDisabledReason`,
 * and deliberately its twin rather than its own idea: Settings → Service asks
 * this same question about the same machine, and the two screens disagreeing
 * about what start-at-login MEANS is worse than either wording alone. The
 * reasons are that file's, word for word.
 *
 * The app-mode reason is the one that matters. "Needs the box above" named a
 * control instead of a fact, and the fact is that the question is still real
 * in app mode — it just has a different answer, and one the person can act on
 * themselves.
 */
export function supervisionLoginReason(probe: Probe, choice: SupervisionChoice): string | null {
  if (!autostartSupported(probe)) return `Needs subshell-server ${MIN_AUTOSTART_SERVER_VERSION}.`;
  if (!choice.background) {
    return "The server starts when the app does. To have it back at login, open Subshell Server at login.";
  }
  return null;
}

export function applySupervisionChoice(
  current: SupervisionChoice,
  change: Partial<SupervisionChoice>,
): SupervisionChoice {
  const background = change.background ?? current.background;
  if (!background) return { background: false, autostart: false };
  if (change.background === true && !current.background) return { background: true, autostart: true };
  return { background: true, autostart: change.autostart ?? current.autostart };
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

/** What the ready screen shows, and whether it waits for a press. */
export interface HandoffView {
  /** true = hold this screen until the person continues; false = open the dashboard now */
  wait: boolean;
  title: string;
  subtitle: string;
}

/**
 * Whether the last screen hands off by itself, or waits to be dismissed.
 *
 * It always opened the dashboard the moment the probe said `ready`, and on a
 * machine that already had everything the setup chain finishes in well under a
 * second — so the checklist the person pressed Set Up to watch appeared and
 * vanished, and the next thing on screen was an account form. Nothing had gone
 * wrong, which is the problem: a flow that skips its own result teaches you
 * that the result was not worth reading (operator report, 2026-09-14).
 *
 * So a run STARTED HERE ends on a screen with a button. `ranSetupHere` is page
 * state rather than a probe fact — `onboarded` cannot answer this, because the
 * probe sets it the first time it sees `ready`, which is the same probe that
 * lands on this screen.
 *
 * Everything else still hands off instantly, and that is the point of the
 * split: an assistant that opens onto an already-running server, or one whose
 * recovery brought it back, has nothing to report and should get out of the
 * way. Only the person who just watched a chain run is owed its result.
 * @param opts.onboarded - Whether this machine had completed setup before
 * @param opts.ranSetupHere - The setup chain completed in THIS window
 * @param opts.continued - They pressed Continue on the waiting screen
 */
export function handoffView(opts: { onboarded: boolean; ranSetupHere: boolean; continued: boolean }): HandoffView {
  if (opts.ranSetupHere && !opts.continued) {
    return {
      wait: true,
      title: "Subshell Server Is Ready",
      subtitle: "Everything below is set up and running. Next, create your account.",
    };
  }
  return {
    wait: false,
    // A first run is finishing; an onboarded machine whose server just came
    // back was never setting anything up, and saying so would be the app
    // narrating its own state machine.
    title: opts.onboarded ? "Your Server Is Running" : "Setting Up Subshell…",
    subtitle: "Opening your dashboard…",
  };
}
