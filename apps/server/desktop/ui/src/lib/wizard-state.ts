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
import { effectiveForm } from "./config-form";
import type { ActionResult, Probe, ProbeStep } from "./ipc";

/**
 * Every screen this window can show.
 *
 * `welcome` leads the first run (back by operator request, 2026-09-18), and
 * behind it `tmux` and `setup` are the first run's ACT — at most ONE of them
 * is ever on the list (spec 2026-09-17 § 4.1), and `setup` auto-fires rather
 * than being walked to (see {@link autoSetupDecision}; the fire waits for the
 * welcome's press because it lives in `renderSetup`). `recovery` is what a
 * machine that
 * has been set up sees while its server is not answering, and `permissions`,
 * `update`, `reset`, `supervision` and `settings` are entered by REQUEST — a
 * `desktop-screen` event from the SPA or the tray, or a link on the recovery
 * screen — over whatever is showing.
 *
 * `settings` is **Server Addresses** (spec 2026-09-18 § 14): the four values
 * that decide whether this server is reachable, edited from the one page that
 * needs no session to save them. It is the only requested screen the dashboard
 * never names — a machine signed out of its own dashboard by an https base URL
 * is precisely why it exists — so its doors are the tray and the recovery
 * screen.
 *
 * `update` is ONE screen since spec 2026-09-18 § 8: it updates the app and the
 * server that app ships, in one act across the relaunch between them. The
 * `app-update` id it absorbed is deleted rather than aliased — this product has
 * no installed base to keep compatible — so a caller still sending that word
 * falls to the probe's own answer, loudly, instead of landing somewhere that
 * happens to be right.
 *
 * The permissions step left the journey with spec 2026-09-17 (D3) and came
 * back on the other SIDE of it (operator's call, 2026-09-18): it is no longer
 * a screen the first run walks THROUGH — nothing is asked before there is a
 * running server — but the ready screen's Continue now hands off to it rather
 * than to the dashboard, on macOS, once. See {@link permissionsAfterSetup}.
 * It is still a requested screen and nothing else: it is never on
 * {@link screensFor}'s list, and the dashboard's detection notices remain its
 * other door.
 *
 * `welcome` left with the same spec (D1, "a first run announces itself by
 * DOING") and came BACK the next day by operator request — "reset / initial
 * state should always show it again". The zero-touch half of D1 survives
 * unchanged: the intro does not re-arm the journey, it PRECEDES it, and the
 * automatic setup fires on the first render past the press rather than under
 * the intro (the gate is structural — the fire lives in `renderSetup`, which
 * the welcome screen does not call).
 */
export type ScreenId =
  | "welcome"
  | "tmux"
  | "setup"
  | "recovery"
  | "permissions"
  | "update"
  | "reset"
  | "supervision"
  | "settings";

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
 * 2026-09-17 (D3) and stayed on THIS list, which is what let it come back on
 * 2026-09-18 with no routing change at all: the ready screen's Continue names
 * it the same way a dashboard notice does (see {@link permissionsAfterSetup}),
 * so there is still exactly one way into it.
 *
 * `settings` — **Server Addresses** (spec 2026-09-18 § 14) — is the newest, and
 * its doors say what it is for: the TRAY, and a link on the recovery screen.
 * No dashboard surface links it, because the machine it exists for is the one
 * whose dashboard cannot be signed into — a description of what we built, not
 * a rule anything enforces: `settings` is a member of this list like the
 * others, so a dashboard surface could name it tomorrow through the
 * `desktop_open_assistant` grant it already holds. That would be a decision to
 * take on its merits rather than a hole; the screen changes nothing a signed-in
 * admin cannot change on the Networking page.
 */
export const REQUESTED_SCREENS: readonly ScreenId[] = ["update", "reset", "supervision", "permissions", "settings"];

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
  // `welcome` leads a first run ONLY — recovery repairs, it does not greet.
  // A reset makes the machine un-onboarded again, and the list is derived
  // from the probe every render, so "reset / initial state should always
  // show it again" (operator, 2026-09-18) needs no state of its own: the
  // derivation already restarts.
  if (!onboarded) return ["welcome", probe.tmux === null ? "tmux" : "setup"];
  return ["recovery"];
}

/**
 * Whether the first-run setup screen may FIRE ITSELF, or must show the form
 * (spec 2026-09-17 § 4.2/§ 4.3).
 *
 * Fire is the ordinary path — past the welcome press, defaults fine, the
 * chain starts.
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

/**
 * The two address facts the checklist shows, resolved the way the rest of
 * the page resolves them: a value the FORM holds outranks (typed, or seeded
 * when the Customize disclosure rendered), and until then the row reads the
 * machine — `status --json`'s effective settings — not the form's blanks.
 *
 * `setupRows` cannot fall back internally because a field the person typed
 * is not distinguishable from a field never rendered inside the form
 * object alone, and this page's zero-touch path — and the recovery screen's
 * Set Up — fires the chain without EVER rendering the form. Raw fields then
 * printed "port 3080, all interfaces" under the ready screen's "Everything
 * below is set up and running" on a machine the chain had just left on the
 * stored 4000. Same ladder the page's `chosenPort` walks for the port
 * conflict check.
 */
export function checklistAddresses(probe: Probe, form: { port: string; host: string }): { port: string; host: string } {
  const stored = effectiveForm(probe.status?.settings);
  return { port: form.port || stored.port, host: form.host || stored.host };
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

/**
 * A program's last word, or `undefined` when it said nothing at all.
 *
 * Exported because the page compares a MESSAGE against a RESULT with it. `act`
 * puts `errText(err)` on the problem line whole and untrimmed, while
 * `failureLine` reduces the same text to its last non-empty line — so an exact
 * string comparison between the two misses on any multi-line rejection, and
 * the duplicate report the suppression exists to prevent comes back.
 */
export function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
}

/** The one line under a failed row: the CLI's last word on stderr, else stdout's, else a fixed sentence. */
export function failureLine(result: ActionResult): string {
  return lastLine(result.stderr) ?? lastLine(result.stdout) ?? "Setup stopped.";
}

/** What the tmux screen says about an install that has already run here. */
export interface TmuxInstallFailure {
  /** The sentence that names what went wrong, in the app's own words. */
  headline: string;
  /** The package manager's last word — empty when it said nothing. */
  line: string;
  /** Both streams, for the disclosure — empty when the run produced no output. */
  output: string;
}

/**
 * Whether the tmux install this window ran left the machine still without
 * tmux, and what to say about it (operator's report, 2026-09-18).
 *
 * The screen had exactly one way to report a failed install: `act` put
 * `failureLine`'s single line into the shared problem paragraph and redrew
 * the same "Install tmux" button underneath it. A package manager's LAST
 * stderr line is usually a fragment — `brew update-reset`, a "Please report
 * this issue" tail — so the screen read as though the press had done nothing
 * at all. Hence a headline this app writes rather than one the manager
 * happens to end on, with the manager's own words kept beside it rather than
 * in place of it.
 *
 * **Two failures, not one**, and the second is the one nothing could see.
 * A non-zero exit is reported by `ActionResult.ok`; an install that exits
 * ZERO and still leaves no tmux on the login PATH — a formula that unpacked
 * but did not link, a deadline that killed the child after the manager had
 * already printed its summary, a manager that installed something else
 * entirely — was indistinguishable from a button nobody had pressed. It gets
 * its own sentence, because "it finished and it still isn't here" is a
 * different problem with a different fix from "it stopped".
 *
 * `null` means there is nothing to report: no install has run in this window,
 * or tmux is now present — in which case this screen is about to leave by
 * itself and a failure block would be a verdict on a question already
 * answered.
 *
 * @param result - the install's own result, or `null` if none has run here
 * @param tmuxFound - whether the probe can now see a tmux
 */
export function tmuxInstallFailure(result: ActionResult | null, tmuxFound: boolean): TmuxInstallFailure | null {
  if (result === null || tmuxFound) return null;
  // stdout first: a manager narrates its progress there and complains on
  // stderr, so reading in that order puts the complaint at the bottom, which
  // is where a reader of a terminal looks for it.
  const output = [result.stdout, result.stderr]
    .map((stream) => stream.replace(/\s+$/, ""))
    .filter((stream) => stream !== "")
    .join("\n");
  return {
    headline: result.ok
      ? "The installer finished, but tmux still isn't on this machine's PATH."
      : "The tmux install didn't finish.",
    // The failed case prefers stderr, where the reason is; the finished-but-
    // absent case has no complaint to find, so it shows whatever the manager
    // said last. Empty is a real answer for both and the screen omits the line
    // rather than inventing one — `failureLine`'s "Setup stopped." fallback is
    // a sentence for a checklist row, and here it would be a second headline
    // disagreeing with the one above it.
    line: (result.ok ? lastLine(output) : (lastLine(result.stderr) ?? lastLine(result.stdout))) ?? "",
    output,
  };
}

/** What the ready screen says before the dashboard takes over. */
export interface HandoffView {
  /**
   * Whether the screen waits for a Continue instead of opening the
   * dashboard itself. True only for the handoff of a chain that ran in
   * THIS window, before the person has pressed (see {@link handoffView}).
   */
  wait: boolean;
  title: string;
  subtitle: string;
}

/**
 * Whether the last screen hands off by itself, or waits to be dismissed.
 *
 * 2026-09-14 put a press here, because "a chain that finishes in under a
 * second flashed its checklist past and taught the reader the result was
 * not worth reading". Spec 2026-09-17 § 4.2 deleted it when the chain
 * started firing itself: nobody owed a dismissal to a run nobody chose to
 * watch. The operator report of 2026-09-17 restored it the same day, and
 * the two rulings name the SAME defect from opposite ends — a screen that
 * navigates away by itself at the moment it turns into an answer is
 * jarring whichever way the run arrived. So: a chain that ran IN THIS
 * WINDOW ends on the completed checklist with a Continue that is the
 * person's press, not the window's; anything else — a window opened over a
 * running server, a requested screen dismissed back to ready, a recovery
 * Start that simply started the service — hands off as its title says.
 *
 * Why `ranSetupHere` must be page state rather than a probe fact: the
 * probe marks `onboarded` on the very `ready` that reaches this screen
 * (R16), so at handoff time `onboarded` cannot tell "this window just set
 * the machine up" from "someone reopened the assistant over a server that
 * was already running". It also cannot steer the waiting SUBTITLE: the
 * recovery screen's Set Up runs the same chain, so on this screen
 * `ranSetupHere` does not license an "account creation" sentence either —
 * the deleted design carried one unconditionally, which lied to a machine
 * that lost its binary and re-set itself up.
 *
 * The non-waiting title still differs by family: a first run is finishing,
 * and an onboarded machine whose server just came back was never setting
 * anything up — telling it so would be the app narrating its own state
 * machine.
 */
export function handoffView(opts: { onboarded: boolean; ranSetupHere: boolean; continued: boolean }): HandoffView {
  if (opts.ranSetupHere && !opts.continued) {
    return {
      wait: true,
      title: "Subshell Server Is Ready",
      // States the fact the checklist below shows and nothing this screen
      // cannot know — see the subtitle note above.
      subtitle: "Everything below is set up and running.",
    };
  }
  return {
    wait: false,
    title: opts.onboarded ? "Your Server Is Running" : "Setting Up Subshell…",
    subtitle: "Opening your dashboard…",
  };
}

/**
 * Whether the ready screen's Continue hands off to the permissions screen
 * rather than straight to the dashboard (operator's call, 2026-09-18).
 *
 * This REVERSES D3 of spec 2026-09-17, which took the permissions step off
 * the first run on the grounds that the dashboard's own detection notices
 * were a better door — "the screen appears when a permission is actually
 * missing, rather than four screens before anything needs one". The report
 * that reversed it is the other half of that trade, measured on a real first
 * run: a person who has just watched a server install itself expects to be
 * told what macOS is about to ask, and a first run that goes straight to a
 * sign-in page has quietly spent the one moment when the explanation is
 * cheap. macOS asks each of these exactly once.
 *
 * It sits AFTER the chain rather than before it, which is what keeps D1's
 * zero-touch first run intact: nothing is asked of anyone until there is a
 * running server to be notified about, and the press that reaches it is the
 * Continue the ready screen already had.
 *
 * Three conditions, each load-bearing:
 *
 * - **darwin only.** The screen is three macOS permissions; there is no Linux
 *   equivalent and the rows would all read as unavailable.
 * - **a chain that ran in THIS window** — the same `ranSetupHere` the Continue
 *   press itself is gated on, so a window opened over an already-running
 *   server never routes here.
 * - **a machine that was not onboarded when that chain STARTED.** A recovery
 *   Set Up runs the same chain on a machine that has been through all of this
 *   before, and re-explaining macOS to it would be the app narrating its own
 *   state machine. It cannot be read off the probe at handoff time — the probe
 *   marks `onboarded` on the very `ready` that reaches this screen — so the
 *   caller captures it before the chain fires.
 */
export function permissionsAfterSetup(opts: {
  platform: string;
  ranSetupHere: boolean;
  ranFirstRunHere: boolean;
}): boolean {
  return opts.platform === "darwin" && opts.ranSetupHere && opts.ranFirstRunHere;
}
