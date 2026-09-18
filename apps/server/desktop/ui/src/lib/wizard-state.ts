/**
 * The assistant's decisions, pure (spec 2026-09-11 § 5, § 8.1; spec
 * 2026-09-12 § 5.3; spec 2026-09-17 § 4).
 *
 * Which screens exist for THIS machine, whether the first run may auto-fire or
 * must show the form, which checklist rows are ticked, whether Set Up may be
 * pressed and why not, which of the CLI's words go under a failed row, and —
 * since the console window went — what the one recovery screen is called and
 * what its single action does. Page state (the current screen, running, the
 * last result) stays in wizard.ts; only facts a probe licenses live here, so a
 * reopen after a quit or a CLI-driven half-setup renders honestly.
 */
import type { ActionResult, Probe, ProbeStep } from "./ipc";

/**
 * Every screen this window can show.
 *
 * `tmux` and `setup` are the first run — at most ONE of them is ever on the
 * list (spec 2026-09-17 § 4.1), and `setup` auto-fires rather than being
 * walked to (see {@link autoSetupDecision}). `recovery` is what a machine that
 * has been set up sees while its server is not answering, and `permissions`,
 * `update`, `app-update`, `reset` and `supervision` are entered by REQUEST — a
 * `desktop-screen` event from the SPA or the tray, or a link on the recovery
 * screen — over whatever is showing.
 *
 * `welcome` and the permissions step left the journey with spec 2026-09-17
 * (D1/D3): a first run announces itself by DOING, and the permission prompts
 * it explained are deferred until the dashboard notices one is missing —
 * which is exactly when the screen is still reachable, as a request.
 */
export type ScreenId =
  | "tmux"
  | "setup"
  | "recovery"
  | "permissions"
  | "update"
  | "app-update"
  | "reset"
  | "supervision";

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
 * The screens a page (or the tray) may name rather than earn from a probe.
 *
 * None of them is ever in {@link screensFor}'s list, which is what lets them
 * appear over a first run as readily as over a recovery without either family
 * having to name them. `permissions` left the macOS first run with spec
 * 2026-09-17 (D3) and stayed on THIS list on purpose: every dashboard notice
 * that says a permission is missing still sends the person to the screen that
 * explains it, and the screen has nothing a first run needed it for.
 */
export const REQUESTED_SCREENS: readonly ScreenId[] = ["update", "app-update", "reset", "supervision", "permissions"];

/**
 * Whether this screen was asked for rather than implied by the probe.
 *
 * The page must let a requested screen OUTRANK an empty {@link screensFor},
 * and that is not a nicety: an empty list means "ready", which the page reads
 * as "open the dashboard and step this window back". Every requested screen
 * renders over a ready machine by definition — Update deep-links onto a
 * running server, and Reset, Supervision and Permissions are all asked for
 * from that server's own dashboard — so without this the window closes itself
 * the moment the probe answers.
 *
 * Since spec 2026-09-17 no screen is on BOTH this list and a journey's, so
 * the question "was this visit a request?" has the simple answer it never had
 * while `permissions` was both.
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

export function isRequestedScreen(screen: ScreenId | null): screen is ScreenId {
  return screen !== null && REQUESTED_SCREENS.includes(screen);
}

/**
 * The screens this machine will see (spec 2026-09-17 § 4.1).
 *
 * A `ready` probe empties the list whichever family the machine is in — the
 * dashboard is what comes next, and a screen list with anything in it would
 * render behind it. A machine that has never finished setup sees at most ONE
 * screen: the named tmux stop while tmux is missing, the auto-firing setup
 * screen once it is not. An onboarded machine that is not ready sees the one
 * recovery screen.
 *
 * The tmux rule CHANGED here, deliberately. It was shown on EVERY first run
 * (2026-09-12) because `dots` positioned by `FIRST_RUN.indexOf` and a
 * filtered screen left a gap in the row that read as a bug — the always-shown
 * screen existed to keep the dots honest. Spec 2026-09-17 removed the dots
 * with the journey: a first run is one automatic screen now, there is no
 * row to keep honest, and D2 says the only unasked-to-third-party stop is
 * tmux. The server binary ships inside the app, so proceeding past it
 * installs nothing foreign; stopping HERE is the one pause a person sees
 * coming, and a machine that already has tmux is never asked to press
 * through a screen about it.
 */
export function screensFor(probe: Probe, onboarded: boolean): ScreenId[] {
  if (probe.next === "ready") return [];
  if (!onboarded) return probe.tmux === null ? ["tmux"] : ["setup"];
  return ["recovery"];
}

/**
 * Whether the first-run setup screen may FIRE ITSELF, or must show the form
 * (spec 2026-09-17 § 4.2/§ 4.3).
 *
 * Fire is the ordinary path — window open, defaults fine, the chain starts.
 * Form means "this machine earned the questions": something already answers
 * on the port (auto-picking a different one silently is refused on the
 * "config written the user never saw" rule), or there is no bundled server to
 * install and "Choose an existing server…" is the only way forward, or tmux
 * is missing and the setup chain would refuse anyway.
 *
 * @param conflict - exactly as {@link canSetup} takes it: present only when
 *   the port is MEASURED busy. Unknown — the round trip still outstanding on
 *   the very first render — must arrive as absent, and the caller holds fire
 *   until the answer lands rather than guessing at a port it has not checked.
 * @param busy - an act in flight; the page folds its own `running` in here,
 *   and {@link startSetup} guards again because a decision is not a lock.
 */
export function autoSetupDecision(
  probe: Probe | null,
  conflict: { port: string } | null | undefined,
  busy: boolean,
): { mode: "fire" } | { mode: "form" } {
  if (!canSetup(probe, busy, conflict).ok) return { mode: "form" };
  if (probe?.serverChoice === "no-bundled") return { mode: "form" };
  return { mode: "fire" };
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

// The dot row is GONE (spec 2026-09-17 § 4.1). It counted a journey, and the
// first run is no longer a journey — it is one automatic screen, and a dot
// row over a screen that fires itself has nothing to count. The function that
// computed positions lived here precisely so the row's arithmetic was testable
// without a webview; with the row gone there is no arithmetic to test, and
// keeping the function would keep the fiction that the positions mean
// something.

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
 * It moves with the server's package version: the app ships THAT build in its
 * bundle, so it is the one release whose verbs this app can vouch for — older
 * cuts carry the verbs too, but a machine on an older installed copy is asked
 * to catch up rather than guessed about. It began at 0.5.0, which never
 * shipped, and has moved at each release step since — 0.6.0, then 0.8.0, now
 * 0.9.0 — each time naming the build the next desktop cut bundles.
 *
 * The test beside it (`wizard-state.test.ts`) turns red the moment a server
 * bump moves past it — which is what caught this one, in CI, on the commit
 * that merged the version PR. Bumping it is a RELEASE step: do it when the
 * server's package version changes, not before.
 */
export const MIN_AUTOSTART_SERVER_VERSION = "0.9.0";

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
 * means busy: a spinner is already on screen. Two machine gates now: tmux
 * (`init` and `service install` both refuse without it), and a port something
 * else already holds; a missing server is the chain's own first act.
 *
 * The order is not cosmetic. The first three refusals are about whether the
 * question can be asked at all — no probe, an act in flight, no tmux — and the
 * port check is about the answer. A screen that named a port conflict while
 * still waiting for its first probe would be reporting a measurement it has
 * not taken.
 *
 * @param portConflict - The port the chain would bind, when something is
 *   already answering there; `null` or omitted for "free, or not known yet".
 *   An OBJECT rather than a port string, because what is on the port is the
 *   question this cannot answer yet — this app's own child, a server someone
 *   started by hand, and an unrelated program are three situations a connect
 *   cannot tell apart. A classification arrives as another field here, and the
 *   reason string grows with it; nothing about the refusal's place in the
 *   order changes.
 *   **Unknown must arrive as absent, never as a conflict.** The check is a
 *   round trip that lands after the render asking for it, so the gate has to
 *   be open while it is outstanding: a Set Up that stays dead for a beat after
 *   every keystroke is indistinguishable from one that is dead for good.
 */
export function canSetup(
  probe: Probe | null,
  busy: boolean,
  portConflict?: { port: string } | null,
): { ok: true } | { ok: false; reason: string } {
  if (probe === null) return { ok: false, reason: "Checking this machine…" };
  if (busy) return { ok: false, reason: "" };
  if (probe.tmux === null) return { ok: false, reason: "Waiting for tmux" };
  // Short because it renders in a span beside the button; the screen itself
  // carries the explanation and the two ways out.
  if (portConflict) return { ok: false, reason: `Port ${portConflict.port} is in use` };
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

/** What the ready screen says before the dashboard takes over. */
export interface HandoffView {
  title: string;
  subtitle: string;
}

/**
 * Whether the last screen hands off by itself: it always does.
 *
 * It used to WAIT for a press when the setup chain had run in this window
 * (2026-09-14: a chain that finishes in under a second flashed its checklist
 * past and taught the reader the result was not worth reading). Spec
 * 2026-09-17 § 4.2 removed the press with the press it was waiting for — the
 * chain now fires itself, so nobody "watched a chain run" in the sense that
 * owed them a dismissal, and the handoff screen survives only as the "Opening
 * your dashboard…" moment its title already names. The progress checklist is
 * still the screen that ran; it simply hands off when it finishes.
 *
 * The title still differs by family: a first run is finishing, and an
 * onboarded machine whose server just came back was never setting anything up
 * — telling it so would be the app narrating its own state machine.
 * @param opts.onboarded - Whether this machine had completed setup before
 */
export function handoffView(opts: { onboarded: boolean }): HandoffView {
  return {
    title: opts.onboarded ? "Your Server Is Running" : "Setting Up Subshell…",
    subtitle: "Opening your dashboard…",
  };
}
