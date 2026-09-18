/**
 * The assistant (spec 2026-09-11 § 5; spec 2026-09-12 § 5.3): one fixed frame
 * and one screen at a time.
 *
 * It owns everything that has to render with the server DOWN — the first run
 * (spec 2026-09-17: one automatic screen, with the named tmux stop in front
 * of it only where tmux is missing), the one Recovery screen a machine sees
 * once it has been set up and its server is not answering, the one Update
 * screen (spec 2026-09-18: the app and the server it ships, in one act across
 * the relaunch between them), and Reset — and it is the only page granted the
 * commands that drive the CLI. `screensFor(probe, onboarded)` picks the
 * family; `update`, `permissions` and `reset` are entered by REQUEST, from the
 * SPA's own cards over `desktop_open_assistant`, from the tray, or from the
 * recovery screen's links.
 *
 * DOM only. Every judgment is imported from `lib/wizard-state.ts` and
 * `lib/recovery-model.ts`, both pure and tested without a webview, and every
 * screen module lives under `assistant/` and takes an `AssistantHost` rather
 * than importing this file — a cycle back to the entry point is a temporal
 * dead zone at module evaluation, i.e. a blank window on the machine someone
 * is trying to repair.
 */
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyButton } from "./assistant/copy-button";
import { type AssistantHost, el, errText } from "./assistant/host";
import { renderOutput, renderTail } from "./assistant/logs";
import { createResetView } from "./assistant/reset-view";
import { buildTmuxWarning, type TmuxWarning } from "./assistant/tmux-warning";
import {
  CONFIG_FIELDS,
  configPayload,
  dashboardUrl,
  derivedBaseUrl,
  type ExplicitMap,
  effectiveForm,
  explicitFields,
  type FormValues,
  fieldProblems,
} from "./lib/config-form";
import { type ManualRoute, manualTmuxRoutes, tmuxInstallPlan } from "./lib/installers";
import type { About, ActionResult, AppUpdateCheck, LogTail, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import { type PermissionRequest, permissionRows } from "./lib/permissions-model";
import { recoveryFacts, recoverySubtitle } from "./lib/recovery-model";
import {
  type ActState,
  NO_SELECTION,
  rejectedResult,
  UPDATE_TITLE,
  type UpdateActSelection,
  updateAct,
} from "./lib/update-act";
import {
  applySupervisionChoice,
  autoSetupDecision,
  autostartSupported,
  canSetup,
  checklistAddresses,
  DEFAULT_SUPERVISION,
  failureLine,
  handoffView,
  isRequestedScreen,
  lastLine,
  MIN_AUTOSTART_SERVER_VERSION,
  permissionsAfterSetup,
  prereqState,
  RESET_LABEL,
  type RecoveryActionKind,
  recoveryAction,
  recoveryTitle,
  type ScreenId,
  SETUP_TITLE,
  type SupervisionChoice,
  screenForRequest,
  screensFor,
  setupRows,
  supervisionLoginReason,
  type TmuxInstallFailure,
  tmuxInstallFailure,
} from "./lib/wizard-state";
import "./styles.css";

const POLL_MS = 1500;

// ---------------------------------------------------------------------------
// State. The current screen is the one piece of page memory; everything else
// is a probe fact or an in-flight action.
// ---------------------------------------------------------------------------
let probe: Probe | null = null;
/**
 * The screen showing, or `null` for "whatever the probe implies".
 *
 * `null` is what a requested screen is dismissed BACK to, and what the first
 * probe resolves; it is not a fourth state to render.
 */
let screen: ScreenId | null = null;
/** A one-off act (tmux install, pick a binary) is in flight. */
let busy = false;
/** The setup chain is running. The poll must not stop for that. */
let running = false;
/** The chain's last answer when it stopped short; cleared by Try Again. */
let failure: ActionResult | null = null;
/** True once this page has asked for the dashboard. Never twice. */
let opened = false;
/** The dashboard refused to open, so stop retrying and let the human press something. */
let openFailed = false;
let problem = "";
let customizeOpen = false;
/** The last action's own words, for the recovery screen's Show Details. */
let lastResult: ActionResult | null = null;
/**
 * The tmux install's own progress: the manager's last output line, and when
 * the install began.
 *
 * `brew install` on a cold cache runs for minutes under a 10-minute deadline,
 * and the command used to report nothing until it returned — a screen that
 * cannot say anything for that long is indistinguishable from a hung one.
 * The manager's output is the only honest progress signal here; there is no
 * percentage to invent, so the last line and a clock are what there is.
 */
let installLine = "";
/**
 * The tmux install's own last answer, or `null` when none has run in this
 * window (operator's report, 2026-09-18).
 *
 * Its OWN slot rather than `lastResult`, which every `act` overwrites: the
 * failure block is a verdict on the tmux install specifically, and a result
 * left by some other press rendering under "The tmux install didn't finish."
 * would be this screen inventing a failure out of another screen's words.
 * Cleared by the next press and by a tmux that appears.
 */
let tmuxResult: ActionResult | null = null;
/**
 * Whether the failed install's output disclosure is expanded.
 *
 * Page state for the reason {@link detailsOpen} is, and separate from it for a
 * different one: the poll refreshes the server log tail while THAT one is
 * open, which would be a CLI spawn every 1500 ms on a screen with no server
 * to ask.
 */
let tmuxOutputOpen = false;
/**
 * How far down that output the reader has scrolled.
 *
 * Page state for the same reason its openness is, and needed for a sharper
 * reason: the poll re-renders twice a second and `clear("content")` rebuilds
 * the `<pre>`, so the offset went back to zero on every tick — and the pane is
 * capped at 180px, which made anything past the first screenful of a `brew`
 * log unreadable. The recovery screen's panes get away with the same rebuild
 * because their CONTENT changes each poll; this text is static, so the reset
 * is pure loss.
 */
let tmuxOutputScroll = 0;
let installStartedAt = 0;
/** The last log tail, refreshed on the poll only while the disclosure is open. */
let lastTail: LogTail | null = null;
/**
 * Whether Show Details is expanded.
 *
 * Page state rather than the element's, because `#content` is rebuilt on
 * every render and the poll renders every 1500 ms — a `<details>` whose
 * openness lived only in the DOM would collapse under the reader twice a
 * second. (The failure screen had exactly that defect.)
 */
let detailsOpen = false;
/** True while the ready handoff is on screen, so its entrance replays once. */
let handedOff = false;
/** Which manager's instructions the tmux screen is showing, or null for none yet. */
let manualRoute: ManualRoute["target"] | null = null;
/**
 * The setup chain has fired itself once in THIS window load (spec
 * 2026-09-17 § 4.2). One fire per load: the poll re-renders the setup screen
 * twice a second, and a chain re-entered on every tick would be a new chain
 * attempt per tick if the first were ever to fall out of `running` without a
 * `failure` set. A reload after a crash re-fires, and the chain is idempotent
 * (`already_installed` compares size and version, `service install` no-ops on
 * an existing unit), so a half-finished first run resumes rather than
 * duplicating. A completed RESET clears it through `host.rearmFirstRun` —
 * the wipe is a new first run inside the same window load, and its welcome
 * press must be able to fire.
 */
let autoFired = false;
/**
 * The setup chain ran to completion in THIS window, so the ready screen
 * owes the person its result rather than vanishing into the dashboard
 * (spec 2026-09-17 § 4.2 deleted this and the operator report restored it
 * the same day — see {@link handoffView}). Page state on purpose:
 * `probe.onboarded` cannot answer it, since the probe sets that flag on the
 * very first `ready` it sees.
 */
let ranSetupHere = false;
/**
 * That chain was a FIRST RUN — the machine was not onboarded when it started.
 *
 * Captured at the press rather than read at the handoff, because by then the
 * probe has already flagged `onboarded` on the very `ready` that got there.
 * A recovery Set Up runs the same chain on a machine that has been through
 * all of this before, and this is the only thing that can tell them apart.
 * See {@link permissionsAfterSetup}, its one consumer.
 */
let ranFirstRunHere = false;
/** They pressed Continue on that screen. */
let continued = false;
/**
 * The ready screen's Continue sent them to the permissions screen, so its own
 * press is a Continue that opens the dashboard rather than a Back that drops
 * them where the probe implies.
 *
 * The screen is reached two ways now and it has to say which door it came
 * through: from a dashboard notice there IS somewhere to go back to, and from
 * the handoff there is not — the window's whole remaining job is to open the
 * dashboard, and a "Back" that did it would be the button lying about where
 * it leads.
 */
let permissionsAfterHandoff = false;
/**
 * A request of ours is in flight — macOS's own sheet is up.
 *
 * One flag per permission, never one shared flag: the two sheets are different
 * questions, and a single flag would spin the Photos row while the person read
 * the notifications sheet.
 *
 * Page state rather than a probe fact, because no probe can see it: the sheet
 * is modal to the app and the answer only reaches `notificationPermission` or
 * `photosPermission` on a later tick. Without it the row would sit at
 * `pending` with a dead button for as long as the person takes to read the
 * sheet, which is the same shape as a hang.
 */
let requestingNotifications = false;
let requestingPhotos = false;
/**
 * Who made this app, its version and its terms — read ONCE and kept.
 *
 * Nine constants that cannot change while the app runs, so re-reading them
 * per render would be a CLI-free but still pointless round trip. A failed
 * read leaves this null and the disclosure simply omits the block.
 */
let about: About | null = null;
/**
 * The update screen's release answer, which is a NETWORK read and therefore
 * not on the 1500 ms poll.
 *
 * Every other fact this page shows comes from `desktop_probe`, which reads
 * this machine. This one asks the project's release list, and re-asking it
 * twice a second would be the background update check the design explicitly
 * does not have (spec § 14). So the check runs on the screen's first render
 * and on Check Again, and its answer lives here across the renders in between.
 */
let appUpdate: AppUpdateCheck | null = null;
/** What the update screen is doing; the machine's half rides the probe. */
let updateState: ActState = "idle";
/** The download's own last line, from the plugin's progress events. */
let updateProgress = "";
/**
 * The update act's last answer in THIS window — the install, or the restart
 * behind it.
 *
 * Page state, and it has to be, for the reason `ranSetupHere` is: a successful
 * bundled install CLEARS the marker the probe reports, so a screen reading the
 * probe alone would forget what it had just done between one poll and the next
 * and fall back to offering the act again. Its own slot rather than
 * `lastResult`, which every other press overwrites.
 */
let updateResult: ActionResult | null = null;
/**
 * The second half of an update has been fired in THIS window load.
 *
 * One fire per load, exactly like {@link autoFired}: the poll re-renders the
 * screen twice a second, and the thing that bounds RETRIES is the marker's own
 * attempt count (`MAX_RESUME_ATTEMPTS`, incremented at boot), not this. What
 * this prevents is a second chain inside one load — a press and a tick racing
 * for the same install.
 */
let resumeFired = false;
/**
 * What the person has ticked on the update screen (spec 2026-09-18 § 13).
 *
 * Page state for the reason {@link detailsOpen} is — `#content` is rebuilt on
 * every render and the poll renders twice a second, so a tick living in the DOM
 * would be cleared under the hand that made it. Held as OVERRIDES rather than
 * as the answer: an absent row id means untouched, so the model's default
 * ("everything actionable, ticked") follows the machine as the probe changes,
 * and a box cleared for a row that stops existing takes nothing with it.
 */
let updateSelection: UpdateActSelection = NO_SELECTION;
const form: FormValues = effectiveForm(undefined);
const explicit: ExplicitMap = {};
/** The two supervision boxes on the setup screen; reset with the form. */
let supervision: SupervisionChoice = DEFAULT_SUPERVISION;
/**
 * The supervision screen's own pending choice, held across renders because
 * the poll re-renders twice a second and a radio read from the probe alone
 * would undo the person's selection before they reached Apply. Cleared when
 * the screen is left, so it always opens showing the machine's real state.
 */
let supervisionForm: SupervisionChoice | null = null;
let seeded = false;
/**
 * The last port this page asked about, and the answer for it.
 *
 * Not a probe field, for the same reason the release check is not one: the
 * probe reports the MACHINE, and this reports a number the person may be
 * typing into the address form, which changes without the machine changing.
 * Re-asking on the 1500 ms poll would be a connect attempt per tick for a
 * question nobody re-asked.
 *
 * Keyed by the port so an answer is only ever read back for the port it was
 * measured on: the field moves while a check is in flight, and a cached `true`
 * carried onto the next number would disable Set Up over a port nothing holds.
 */
let portCheck: { port: string; inUse: boolean } | null = null;
/**
 * The port the newest check was fired for.
 *
 * It does two jobs: one render's question is asked once (the poll and the
 * input listener both reach {@link checkPort}), and an answer that arrives
 * after a newer check was fired is DROPPED — two loopback connects race, and
 * the slower one is the older question.
 */
let portAsked: string | null = null;

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------
/**
 * The product wordmark, and nothing else.
 *
 * **The per-screen glyphs are gone (2026-09-14).** Every screen used to open
 * with a 72px lucide outline — a terminal, a server, a cross — above its
 * title, and the box they sat in cost 124px of a frame that is now 620px
 * tall. They were decorative by construction (`aria-hidden`, and the title
 * under each said the same thing in words), so they were 124px spent on
 * repeating the heading. The wordmark stays for the boot frame and for
 * Welcome — screens where there is nothing to say but who is speaking.
 * (Welcome left with spec 2026-09-17 and returned the next day by operator
 * request; {@link renderWelcome} carries the reasoning.)
 *
 * Fixed set, inline, because the CSP allows no remote images.
 */
const ART = {
  icon: `<img src="./wordmark-96.png" srcset="./wordmark-96.png 1x, ./wordmark-192.png 2x" alt="" />`,
  /** Every other screen: the box collapses (`.assistant-art:empty`). */
  none: "",
} as const;

function setFrame(art: keyof typeof ART, title: string, subtitle: string): void {
  el("art").innerHTML = ART[art];
  // `title` and `subtitle` are `aria-live="polite"` regions, and `tick()`
  // calls `render()` on a 1500ms poll: rewriting them with the SAME string
  // is still a DOM mutation, so assistive tech would re-announce them on a
  // timer even when nothing changed on screen.
  const titleEl = el("title");
  if (titleEl.textContent !== title) titleEl.textContent = title;
  const subtitleEl = el("subtitle");
  if (subtitleEl.textContent !== subtitle) subtitleEl.textContent = subtitle;
}
function clear(...ids: string[]): void {
  for (const id of ids) el(id).textContent = "";
}
function button(label: string, handler: () => unknown, cls = "", disabled = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = cls;
  b.disabled = disabled || busy || running;
  b.addEventListener("click", handler);
  return b;
}
function text(tag: "p" | "span" | "div", s: string, cls = ""): HTMLElement {
  const n = document.createElement(tag);
  n.textContent = s;
  n.className = cls;
  return n;
}
/**
 * Where this app is running, in prose. ONE string on both platforms
 * (operator's call, 2026-09-12).
 *
 * It used to answer "this Mac" on darwin. That is the macOS convention and it
 * read well mid-sentence, but it cost a branch and a test matrix on every
 * string that used it, and it was the mechanism behind a real misreading: a
 * label ending on "Mac" — a prefix of the sibling platform's own word — was
 * reported as truncated. The macOS FEEL this assistant is after comes from
 * its shape (one decision per full-window screen, fixed Back and Continue,
 * screens that ask nothing never appearing), not from the vocabulary.
 */
const here = (): string => "this machine";

// ---------------------------------------------------------------------------
// The host every `assistant/` module takes, so none of them imports this file.
// ---------------------------------------------------------------------------
const host: AssistantHost = {
  probe: () => probe,
  // `running` counts: the setup chain owns the machine for as long as it
  // takes, and a control lit through it invites a second press.
  busy: () => busy || running,
  setBusy: (on: boolean) => {
    busy = on;
  },
  render: () => render(),
  refresh: () => refresh(),
  fail: (err: unknown) => setProblem(err),
  close: () => {
    resetView.hide();
    // A pending selection belongs to one visit: leaving and coming back must
    // show the machine's real state, not what someone half-chose last time.
    supervisionForm = null;
    screen = null;
    render();
  },
  rearmFirstRun: () => {
    // See {@link AssistantHost.rearmFirstRun}. `failure` goes with
    // `autoFired` because both describe the PRE-reset chain: a first run
    // that failed at `service install`, got reset instead, and then met the
    // old failure screen under a brand-new welcome would be a ghost.
    autoFired = false;
    failure = null;
  },
};

const resetView = createResetView(host);
/**
 * One warning for the one gated surface. The console needed a factory because
 * two sections rendered at once; here it is a factory for the other half of
 * the same reason — the element is re-appended by every render, and one
 * created per render would throw away a half-finished Copy.
 */
const tmuxWarn: TmuxWarning = buildTmuxWarning(host, () => startTmuxInstall());

// Screens. Each fills #content and the bar; ordering comes from screensFor.
//
// Welcome is GONE (spec 2026-09-17 D1). It announced what the setup chain
// would do, and the chain now does it on sight — the progress checklist that
// used to follow the announcement is the first screen, and it names each act
// as it happens, which is the announcement, at the moment it is true.
// ---------------------------------------------------------------------------
/**
 * Redraws the install screen once a second while it runs.
 *
 * Its own timer because the ordinary poll (`tick`) returns early while `busy`,
 * deliberately — a refresh under a running action is what it exists to avoid.
 * So during the one action whose screen has to keep moving, nothing was
 * repainting it at all.
 */
let installClock: ReturnType<typeof setInterval> | null = null;

function startInstallClock(): void {
  if (installClock !== null) return;
  installClock = setInterval(() => {
    if (installStartedAt === 0) {
      stopInstallClock();
      return;
    }
    render();
  }, 1000);
}

function stopInstallClock(): void {
  if (installClock === null) return;
  clearInterval(installClock);
  installClock = null;
}

/** `m:ss` since the install began. */
function elapsed(sinceMs: number): string {
  const total = Math.max(0, Math.round((Date.now() - sinceMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Install tmux — the one press, from both screens that offer it.
 *
 * **It asks the machine before it asks the package manager** (operator's
 * request, 2026-09-18: "retry would also check for the presence of the
 * install"). Someone who has gone off to a terminal, installed tmux by hand
 * and come back is pressing this button to say "look again", not to run brew
 * a second time — and the poll cannot have noticed for them, because it skips
 * while an action is in flight and this screen's whole state is that nothing
 * is. A tmux found here clears the failure and returns: `screensFor` stops
 * listing this screen on the render that follows, which is the same exit the
 * poll takes.
 *
 * The clock is stamped AFTER that check rather than at the press, so the
 * progress pane never counts a probe as install time.
 *
 * A rejection — `NO_MANAGER`, on a platform with nothing to drive — is
 * recorded as a result of its own rather than left to the problem line alone,
 * so the screen's own failure block owns every way this can not work.
 */
function startTmuxInstall(): void {
  if (busy || running) return;
  void act(async () => {
    // Cleared BEFORE the probe, not after it. `act` has already rendered the
    // busy state, so the progress pane is on screen for the length of the
    // round trip — and with the old line still under it, a Try again spent
    // that time showing the PREVIOUS run's last word beneath a fresh spinner.
    tmuxResult = null;
    installLine = "";
    // A new run's output is a new document — keeping the old offset would open
    // the next failure's pane part-way down it.
    tmuxOutputScroll = 0;
    await refresh();
    if (probe?.tmux != null) return null;
    installStartedAt = Date.now();
    startInstallClock();
    render();
    try {
      const result = await ipc.installTmux();
      tmuxResult = result;
      return result;
    } catch (err) {
      tmuxResult = { ok: false, stdout: "", stderr: errText(err) };
      throw err;
    }
  });
}

/**
 * What the install shows while it runs: a spinner, a clock, and the package
 * manager's own last line.
 *
 * The line is the only real progress there is — `brew` reports Fetching, then
 * Pouring, then Summary, and no percentage can be derived from that — so it
 * is shown verbatim rather than translated into a fake stage. The clock earns
 * its place separately: a stalled download leaves the LINE unchanged, and
 * without a second thing moving the screen would look frozen again.
 */
function installProgress(): HTMLElement {
  const box = document.createElement("div");
  box.className = "install-progress";
  const head = document.createElement("p");
  head.className = "install-head";
  const spinner = document.createElement("span");
  spinner.className = "install-spinner";
  spinner.setAttribute("aria-hidden", "true");
  // `aria-live="polite"`, so a screen reader hears the manager's own words as
  // they change rather than nothing at all for ten minutes.
  // The stamp lands after the presence check {@link startTmuxInstall} runs
  // first, so the pane's first frames have none. Counting from the epoch there
  // would print a five-figure clock for a moment, which is the sort of thing
  // that gets screenshotted.
  const since = installStartedAt === 0 ? Date.now() : installStartedAt;
  head.append(spinner, text("span", "Installing tmux…", "label"), text("span", elapsed(since), "detail"));
  box.append(head);
  const line = text("p", installLine || "Starting the package manager…", "install-line");
  line.setAttribute("aria-live", "polite");
  box.append(line);
  return box;
}

/**
 * What an install that did not work says for itself (operator's report,
 * 2026-09-18: "it wasn't clear there was a problem").
 *
 * Three layers, narrowing: the app's own sentence about what happened, the
 * package manager's last word under it, and everything both streams carried
 * behind a disclosure. The last one is what the screen never had — a
 * manager's final stderr line is routinely a fragment (`brew update-reset`,
 * a "Please report this issue" tail) and the reason is four lines above it.
 */
function tmuxFailureBlock(failure: TmuxInstallFailure): HTMLElement {
  // The shared problem line said this once, in one sentence taken from
  // whatever the manager's stderr happened to end on. This card is that
  // failure said properly, so the line is cleared rather than reporting it
  // twice in two different wordings.
  //
  // Only when the line IS this failure, though. `refresh` puts `probe.error`
  // there over the top of an action's message, and a card about a package
  // manager is no reason to hide a machine that cannot be read at all.
  //
  // Here rather than at the two call sites, because both screens that render
  // this card owe the same rule and a copy of it in each is a copy that can
  // drift — the client app pays for the same rule with a prop, for the same
  // reason.
  // `lastLine(problem)` rather than `problem`, because the two paths put
  // different shapes there: a non-ok result gives `failureLine`'s single
  // trimmed line, while a REJECTION gives `errText(err)` whole — untrimmed and
  // possibly multi-line. Compared exactly, a multi-line Rust error left the
  // same failure reported twice, which is the duplication this prevents.
  if (tmuxResult !== null && lastLine(problem) === failureLine(tmuxResult)) el("problem").textContent = "";
  const box = document.createElement("div");
  box.className = "install-failure";
  box.append(text("p", failure.headline, "label"));
  // Empty is a real answer — a spawn that never ran says nothing at all — and
  // an empty line under the headline would be a gap the eye reads as a
  // missing explanation.
  if (failure.line !== "") box.append(text("p", failure.line, "install-line"));
  if (failure.output !== "") {
    const details = document.createElement("details");
    // Its openness is PAGE state, like every other disclosure here: `#content`
    // is rebuilt by a render that runs on the poll's clock, so a `<details>`
    // holding it only in the DOM collapses under the reader twice a second.
    details.open = tmuxOutputOpen;
    details.addEventListener("toggle", () => {
      tmuxOutputOpen = details.open;
    });
    const summary = document.createElement("summary");
    summary.textContent = "Show output";
    const pre = document.createElement("pre");
    // The same treatment the recovery screen's failed action and the reset
    // screen's half-run log get, so three surfaces never phrase one outcome
    // three ways.
    pre.className = "pane-pre output-bad";
    pre.textContent = failure.output;
    pre.addEventListener("scroll", () => {
      tmuxOutputScroll = pre.scrollTop;
    });
    // Restored after the element is in the document, which is the only point
    // at which it has a scroll height to be offset within — assigning before
    // the append silently does nothing.
    queueMicrotask(() => {
      pre.scrollTop = tmuxOutputScroll;
    });
    details.append(summary, pre);
    box.append(details);
  }
  return box;
}

/**
 * The one line a person can paste, with its Copy.
 *
 * A fixed flash key rather than the command's own text: this panel is rebuilt
 * by every render and the key is what the flash outlives the element by, so
 * keying on a string that can change with the platform would move the slot
 * mid-flash.
 */
function manualCommand(command: string): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "manual-steps";
  panel.append(text("p", "Or run this in a terminal:", "hint"));
  const line = document.createElement("div");
  line.className = "manual-command";
  line.append(
    text("span", command, "code-line"),
    copyButton(() => command, { key: "tmux-manual", label: "the install command" }),
  );
  panel.append(line);
  return panel;
}

/**
 * The intro. Wordmark and one sentence — before the first probe there is
 * nothing to say but who is speaking, and the D1 removal (spec 2026-09-17,
 * "a first run announces itself by DOING") lasted one day: the operator
 * asked for it back on 2026-09-18, "reset / initial state should always show
 * it again", which the probe-derived list gives for free.
 *
 * Continue is the only control, and it carries weight: the setup chain's
 * auto-fire lives in {@link renderSetup}, which this screen does not call,
 * so NOTHING has touched the machine while the intro is up. The press does
 * not start a journey — it steps to the one act `screensFor` has behind the
 * greeting (form, auto-fire, or the tmux stop; the choice is the model's,
 * computed here at press time so a tmux that appeared mid-read is honoured).
 */
function renderWelcome(p: Probe): void {
  setFrame(
    "icon",
    "Welcome to Subshell",
    `Subshell runs agent sessions in terminal panes you can watch from any device. Let's set up the server on ${here()}.`,
  );
  el("bar-right").append(
    button(
      "Continue",
      () => {
        const list = screensFor(p, p.onboarded);
        go(list[1] ?? "setup");
      },
      "primary",
    ),
  );
}

/**
 * The one stop on the zero-touch first run (spec 2026-09-17 D2) — and it is
 * only ever reached with tmux MISSING, one Continue past the welcome.
 * `screensFor` puts this screen on the list exactly while `probe.tmux` is
 * null, so there is no "already installed" state to render and no Continue
 * to press: the moment the poll sees a tmux, the list stops containing this
 * screen, `render()` re-resolves PAST the already-pressed welcome to
 * `setup`, and the chain fires itself. That advance is the whole point — the
 * screen that used to be shown on every first run needed the Continue its
 * now-gone found-state carried; this one leaves by itself.
 */
function renderTmux(p: Probe): void {
  // The title names the STEP, not a result — a panel announcing something is
  // ready reads as a verdict on a question nobody asked (2026-09-12), and
  // every machine reaching this screen is at the same step: get tmux.
  setFrame("none", "Install tmux", "Every subshell runs in a tmux pane, so the server needs it before it can start.");
  const content = el("content");
  const plan = tmuxInstallPlan(p.platform, p.hasBrew);
  const failed = tmuxInstallFailure(tmuxResult, p.tmux !== null);
  if (prereqState(p) === "install" && plan.kind === "run") {
    if (busy) {
      content.append(installProgress());
    } else {
      // It says it here now, in the app's own words, next to the manager's,
      // above the button that looked exactly as it had before the press.
      if (failed !== null) content.append(tmuxFailureBlock(failed));
      content.append(
        // "Try again", because pressing a button labelled with the act that
        // just failed asks the reader to believe the same press will do
        // something different this time. It will — it re-reads the machine
        // first — and the label is where that is said.
        button(failed === null ? plan.label : "Try again", () => startTmuxInstall(), "primary big"),
      );
      // Centred under a full-width button: left-aligned, it read as a caption
      // for the screen's left edge rather than for the button it belongs to.
      content.append(text("p", "Your package manager may ask for your password.", "hint centered"));
      // Only once the button has been shown not to work. Printing the line up
      // front asks someone to paste an unexplained command on a window's
      // say-so while a button that does it for them sits above it; printing
      // it HERE answers the question the failure just raised, which is "what
      // do I do instead". The other app's screen carries it unconditionally
      // and that difference is deliberate — a node's tmux screen can be
      // waited on forever, and this one is one step of a first run.
      if (failed !== null) content.append(manualCommand(plan.command.join(" ")));
    }
  } else {
    // ABOVE the instructions, not under them. The screen is already polling
    // (`tick`), so it WILL notice tmux the moment it appears — but a person
    // who has gone off to a terminal and come back reads the top of the pane
    // first, and a window that says nothing about watching looks frozen.
    const checking = document.createElement("p");
    checking.className = "tmux-checking";
    checking.append(text("span", "", "glyph"), text("span", "Checking for tmux…", "label"));
    content.append(checking);
    const routes = manualTmuxRoutes(p.platform);
    if (routes.length === 0) {
      // A platform this app does not ship to: the reading link is the whole
      // honest answer. Naming a command here would be a guess in the one
      // place the reader cannot check it.
      content.append(text("p", "This machine has no package manager this app can drive. In a terminal:", "hint"));
      if (plan.command.length > 0) content.append(text("span", plan.command.join(" "), "code-line"));
      if (plan.docsUrl !== "")
        content.append(button("Read the tmux docs", () => void ipc.openTmuxDocs().catch(setProblem), "ghost"));
    } else {
      // What to DO, not what this machine lacks. It read "This machine has no
      // package manager this app can drive", which explains the app's own
      // position to someone who only wants tmux, and names an absence where a
      // next step belongs (operator's call, 2026-09-14).
      //
      // `wizard-copy centered`, not `hint`: running text introducing the two
      // buttons takes the body role rather than the detail one this screen's
      // asides use, centred under a centred title.
      content.append(text("p", "Installing tmux through Homebrew or MacPorts is recommended.", "wizard-copy centered"));
      // Two ordinary buttons, side by side: no class, so they carry the app's
      // default button look rather than the ghost one, which read as a link
      // and did not say it could be pressed. Pressing one REVEALS that
      // manager's instructions below; nothing is shown until asked for.
      const choices = document.createElement("div");
      choices.className = "manual-routes";
      for (const route of routes) {
        const choice = button(route.name, () => {
          manualRoute = manualRoute === route.target ? null : route.target;
          render();
          refocus(`route-${route.target}`);
        });
        choice.id = `route-${route.target}`;
        choice.setAttribute("aria-pressed", String(manualRoute === route.target));
        choices.append(choice);
      }
      content.append(choices);
      const chosen = routes.find((route) => route.target === manualRoute);
      if (chosen !== undefined) content.append(manualRouteSteps(chosen));
    }
  }
  // NO bar, and that is structural rather than spare: there is nowhere to go
  // BACK to (this is the first screen a first run shows), and no CONTINUE to
  // press — the screen leaves the moment tmux exists, which is the answer
  // Continue used to gate. A press that could only say "I checked and it is
  // still not there" is what the poll is for. (The old "Waiting for tmux"
  // reason text beside Continue read the same during the install the app had
  // itself started; the pane above already says that, with a spinner, a clock
  // and the package manager's own words.)
}

/**
 * One manager's instructions, shown after its button is pressed.
 *
 * Two steps, in the order they happen: get the manager from its own site, then
 * run one line. Only the second is printed here — the line that installs a
 * package MANAGER is a `curl … | bash` nobody should take from a window's
 * say-so, and each project carries it on its own page in its own words.
 */
function manualRouteSteps(route: ManualRoute): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "manual-steps";
  // No numbering: two things in the order they are laid out, where the words
  // carry the order. But each line has to SAY where it leads — "Don't have
  // Homebrew?" over a button that opens a website answers a question with a
  // dead end, leaving "open the site and then what?" (operator's report,
  // 2026-09-14). So the first line says what the site is for and that you come
  // back, and the second says what you can do once you have.
  panel.append(text("p", `Don't have ${route.name}? Install it from its site, then come back.`, "hint"));
  // A MEMBER of the closed URL set, never the address: Rust owns every page
  // this app can open (see `WebTarget`).
  panel.append(button(`Open ${route.name} site`, () => void ipc.openWeb(route.target).catch(setProblem)));
  panel.append(text("p", `Once you have ${route.name}, run:`, "hint"));
  const line = document.createElement("div");
  line.className = "manual-command";
  line.append(
    text("span", route.command, "code-line"),
    // The command is the flash slot: this panel is rebuilt by every render,
    // and one route's tick must not appear on the other's button.
    copyButton(() => route.command, { key: route.command, label: `the ${route.name} command` }),
  );
  panel.append(line);
  return panel;
}

/**
 * The port the setup chain would actually bind.
 *
 * Seeded the way {@link addressForm} seeds its own field, because the form may
 * never have been opened: `form.port` stays empty until it renders once, so
 * reading it alone would ask about port 3080 on a machine configured for 4000.
 * `effectiveForm` is the one place that turns `status --json`'s settings into
 * what the field would show, and the `"3080"` tail is `setupRows`' own
 * fallback — a blank port means the CLI's default, not "no port".
 */
function chosenPort(p: Probe): string {
  return (form.port || effectiveForm(p.status?.settings).port || "").trim() || "3080";
}

/** The URL row's one handle, shared by the render and the input mirror. */
const DASHBOARD_URL_ID = "dashboard-url";

/**
 * What the dashboard row says right now — the address a save would leave the
 * server answering on, in the same three steps `configure` takes:
 *
 * 1. the baseUrl FIELD, once the form exists and holds something — it is what
 *    the save sends;
 * 2. else a STORED base URL — but only one somebody chose. A `default`-sourced
 *    `APP_BASE_URL` is the CLI's own derivation of the port, and letting its
 *    frozen `"…:3080"` outrank the port would recreate the exact stale-port
 *    display `configPayload`'s `explicit` map exists to prevent;
 * 3. else the derivation from `chosenPort`, which is the port field, else the
 *    stored port, else 3080.
 *
 * (A cleared field over a *chosen* stored value shows the stored one, and is
 * honest: `baseUrl` is not the emptyable flag, so that save omits it and the
 * disk value survives.)
 */
function dashboardUrlValue(p: Probe): string {
  const typed = seeded ? form.baseUrl : "";
  const setting = p.status?.settings?.APP_BASE_URL;
  const stored = setting && setting.source !== "default" ? (setting.value ?? "") : "";
  return dashboardUrl(typed || stored, chosenPort(p));
}

/**
 * The address the dashboard will run at — the Set Up screen's first row.
 *
 * The plan rows this screen once carried were deleted because the checklist
 * said them again (see {@link supervisionGroup}); this one came back (the
 * operator's call, 2026-09-17) because it is the different half of what was
 * deleted: not a promise of what setup will DO, but the address the reader
 * will dial afterwards — and the one fact on this screen the Customize link
 * below actually changes. It wears the checklist row's shape (label left,
 * value right) because a URL is a value.
 */
function dashboardLine(p: Probe): HTMLElement {
  const value = text("span", dashboardUrlValue(p), "detail");
  value.id = DASHBOARD_URL_ID;
  const row = document.createElement("div");
  row.className = "dashboard-url";
  row.append(text("span", "Dashboard URL", "label"), value);
  return row;
}

/**
 * Re-text the row in place. The port and base-URL fields never re-render while
 * a hand is in them — `render()` rebuilds `#content` and would take the cursor
 * out mid-keystroke — so the row follows the same rule the baseUrl mirror
 * already follows: update the one element, leave the typing alone.
 */
function syncDashboardUrl(p: Probe): void {
  const node = document.getElementById(DASHBOARD_URL_ID);
  if (node) node.textContent = dashboardUrlValue(p);
}

/**
 * Whether something already holds the port this screen would bind, or `null`
 * for "free — or not measured yet".
 *
 * The render is synchronous and the check is a round trip, so the two states
 * this collapses are deliberate: an unknown port reads as free and Set Up
 * stays live. A button that went dead for a beat after every keystroke would
 * be worse than the failure being closed here, which is a server that cannot
 * bind — a state this machine is already in when the question is asked at all.
 */
function portConflict(p: Probe): { port: string } | null {
  const port = chosenPort(p);
  if (portCheck?.port === port) return portCheck.inUse ? { port } : null;
  checkPort(port);
  return null;
}

/** Ask about one port, unless that answer is already in hand or on its way. */
function checkPort(port: string): void {
  if (portCheck?.port === port || portAsked === port) return;
  const numeric = Number(port);
  // A port that is not a port is the CLI's refusal to make, not this check's:
  // `u16` would reject the invoke outright, and the config form already shows
  // the server's own complaint about the value. Cached as free so the gate
  // opens and the chain gets to report what is actually wrong.
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    portCheck = { port, inUse: false };
    return;
  }
  portAsked = port;
  // Bound to a name so the call stays on one line: `ipc-acl.test.ts` reads
  // which commands this page can reach by matching `ipc.<name>(`, and a chain
  // long enough for the formatter to break after `ipc` would hide this one
  // from that pin — which is the safe-LOOKING direction for it to fail in.
  const asked = ipc.portInUse(numeric);
  asked
    // A refused command is not a busy port. The page has no way to tell them
    // apart and only one of them is safe to assume, so a failed check reads as
    // free and the chain reports the bind failure itself.
    .catch(() => ({ inUse: false }))
    .then(({ inUse }) => {
      // Superseded: the field moved on while this was in flight, and the
      // answer is about a port nothing is asking about.
      if (portAsked !== port) return;
      portCheck = { port, inUse };
      // Never redraw under a hand typing in the address form — `tick()`'s own
      // rule, for the same reason: `render()` rebuilds `#content`, which would
      // take the cursor out of the field mid-port. The answer is cached, so
      // the first render after the field is left carries it.
      if (!isTextEntry(document.activeElement)) render();
    });
}

/**
 * Why Set Up is held back, and the two ways past it.
 *
 * The reason beside the button is four words, which is the right size for a
 * button that is merely waiting and the wrong size for one that will not come
 * back on its own. This says what is true of the machine, what setup would do
 * with it, and both remedies — including the one already on this screen, named
 * in the words its own link uses.
 *
 * **It does not say what is on the port, because this page cannot know.** A
 * connect proves that something answered and nothing more, and the likeliest
 * holders are benign — a `subshell-server` the person started from a terminal,
 * or another copy of this app — so wording that implied a foreign or
 * misbehaving program would be wrong in the ordinary case and alarming in all
 * of them. "Something already answers" is the whole of what was measured.
 */
function portWarning(port: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "port-warning mb-4";
  wrap.append(
    text("p", `Something is already answering on port ${port}.`),
    text(
      "p",
      "Setting up would write that port into this server's configuration and then start a server that cannot " +
        "bind to it, so Set Up waits until the port is free. Stop whatever is using it, or choose a different " +
        "port under “Customize port and addresses…”.",
    ),
  );
  return wrap;
}

function renderSetup(p: Probe): void {
  if (running) {
    renderProgress(p);
    return;
  }
  if (failure) {
    renderFailure(p);
    return;
  }
  // --- Auto-fire (spec 2026-09-17 § 4.2). ---------------------------------
  // The ordinary first run never shows this screen's question: the chain
  // fires itself and the progress checklist is what follows the intro. This
  // function not running under Welcome is the fire's gate — the press at
  // `renderWelcome` is what lets the machine be touched at all.
  // Two things must be true before the fire that the pure decision cannot
  // see, and both belong to the render rather than to `autoSetupDecision`:
  //
  // * the port answer must be IN. The check is a round trip and the decision
  //   treats "unknown" as free (that is what keeps a Set Up button from
  //   dying for a beat per keystroke), but firing on an unmeasured port would
  //   send a machine whose port is busy into a failed chain when § 4.3 wants
  //   it the pre-filled form with the conflict warning. `checkPort`'s own
  //   resolution re-renders, and that render is where the fire happens.
  // * `autoFired` must be clear — one fire per load. A failure is NOT
  //   re-fired (the `failure` branch above returns first); the human presses
  //   Try Again, because a chain that already failed once and re-runs
  //   itself twice a second is the bug, not the feature.
  const conflict = portConflict(p);
  const portKnown = portCheck !== null && portCheck.port === chosenPort(p);
  if (!autoFired && portKnown && autoSetupDecision(p, conflict, busy || running).mode === "fire") {
    autoFired = true;
    void startSetup();
    return; // startSetup renders the progress screen synchronously
  }
  // --- The form: the § 4.3 fallback (port conflict, no bundled server). ---
  setFrame("none", SETUP_TITLE, `Choose how the server runs on ${here()}.`);
  const content = el("content");
  content.append(dashboardLine(p));
  // Above the question, not beside the button: it is the reason the screen
  // cannot be completed, and a reader who starts at the top should meet it
  // before choosing how a server they cannot start yet ought to run.
  if (conflict) content.append(portWarning(conflict.port));
  content.append(supervisionGroup(p));
  const links = document.createElement("div");
  links.className = "mt-4 flex gap-4";
  links.append(
    button(
      customizeOpen ? "Use defaults" : "Customize port and addresses…",
      () => {
        customizeOpen = !customizeOpen;
        if (!customizeOpen) resetForm();
        render();
      },
      // `linkish plain`: this one sits directly under the supervision rows and
      // reads as one of them, so it takes their size and their colour rather
      // than the muted, slightly smaller treatment a link gets elsewhere in
      // the assistant.
      "linkish plain",
    ),
  );
  if (p.serverChoice === "no-bundled")
    links.append(button("Choose an existing server…", () => void pickBinary(), "linkish"));
  content.append(links);
  if (customizeOpen) content.append(addressForm(p));
  // No Back: this is the first screen a machine without tmux trouble ever
  // shows, and the form is the whole screen, not a step with a step before
  // it. The gate and button stay because the fallback path is walked by hand:
  // whoever lands here because the port was busy fixes the port under
  // Customize, and only they can say when the port is theirs to take.
  const gate = canSetup(p, busy, conflict);
  if (!gate.ok && gate.reason) el("bar-right").append(text("span", gate.reason, "reason"));
  el("bar-right").append(button("Set Up", () => void startSetup(), "primary", !gate.ok));
}

/**
 * The supervision question — the whole content of the Set Up screen.
 *
 * **It used to sit under a plan**: two rows promising "Install the server →
 * ~/.local/bin/subshell-server" and "Open your dashboard → http://…". Both
 * were deleted, because they were already said twice — `setupRows` feeds the
 * progress checklist on the VERY NEXT screen, which names each act with the
 * same detail as it happens. Promising them beforehand made a screen whose one
 * real question — who runs this server — read as a footnote under a list of
 * things the reader could not act on. The install row stays deleted for that
 * reason. The address came back (operator's call, 2026-09-17) as
 * {@link dashboardLine}, which is the different half: not a promise of what
 * setup will do, but the address the reader dials afterwards — and the one
 * fact on this screen the Customize link below actually changes, moving while
 * they type it.
 *
 * `apps/server/web`'s supervision card is the shape this follows; see the
 * radio/login split there and in `lib/supervision.ts`.
 */
function supervisionGroup(p: Probe): HTMLElement {
  const locked = busy || running;
  const section = document.createElement("section");
  section.className = "supervision";

  const group = document.createElement("div");
  group.className = "supervision-modes";
  group.setAttribute("role", "radiogroup");
  // The `aria-label` is the group's whole name now. A visible caption saying
  // "How this server runs" sat directly under a subtitle already reading
  // "Choose how the server runs on <host>" — the same sentence twice, once
  // the plan rows above it stopped being there to separate from.
  group.setAttribute("aria-label", "How this server runs");

  const mode = (opts: { id: string; background: boolean; title: string; body: string }): HTMLLabelElement => {
    const label = document.createElement("label");
    label.className = "supervision-mode";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "plan-supervision";
    radio.id = opts.id;
    radio.checked = supervision.background === opts.background;
    radio.disabled = locked;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      supervision = applySupervisionChoice(supervision, { background: opts.background });
      render();
      refocus(opts.id);
    });
    const copy = document.createElement("span");
    copy.className = "supervision-copy";
    copy.append(text("span", opts.title, "label"), text("span", opts.body, "detail"));
    label.append(radio, copy);
    return label;
  };

  // The manager's name goes in the SENTENCE, where it explains something,
  // rather than in the title as a parenthetical that explains nothing —
  // `supervision-card.tsx`'s rule, and its exact words.
  const agent = p.platform === "darwin" ? "A launchd agent" : "A systemd user service";
  group.append(
    mode({
      id: "plan-mode-service",
      background: true,
      title: "In the background",
      body: `${agent} runs it, whether or not Subshell Server is open.`,
    }),
  );
  group.append(
    mode({
      id: "plan-mode-app",
      background: false,
      title: "With the Subshell Server app",
      // The dashboard's sentence, plus the reassurance only this screen is in
      // a position to give: the panes are not the server, and someone
      // choosing app mode is being told the app can stop it.
      body: "Runs while the app is open; quitting the app stops it. Running subshells keep running.",
    }),
  );
  section.append(group);

  const reason = supervisionLoginReason(p, supervision);
  const login = document.createElement("div");
  login.className = "supervision-login";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "plan-autostart";
  box.checked = supervision.autostart && autostartSupported(p);
  box.disabled = reason !== null || locked;
  box.addEventListener("change", () => {
    supervision = applySupervisionChoice(supervision, { autostart: box.checked });
    render();
    refocus("plan-autostart");
  });
  const copy = document.createElement("span");
  copy.className = "supervision-copy";
  const label = document.createElement("label");
  label.className = "label";
  label.htmlFor = "plan-autostart";
  label.textContent = "Start at login";
  copy.append(
    label,
    text(
      "span",
      reason ??
        "Starts the server again the next time you log in to this machine. Without it, the service runs now but nothing brings it back after you log out or restart.",
      "detail",
    ),
  );
  login.append(box, copy);
  section.append(login);
  return section;
}

function renderProgress(p: Probe): void {
  setFrame("none", "Setting Up Subshell…", "This takes a moment.");
  el("content").append(checklist(p, "active"));
}

/**
 * The last screen either family sees: the server answers, so the dashboard
 * is what comes next. It dismisses itself ONLY when this window ran nothing
 * — the handoff of a chain that ran here holds the completed checklist and
 * waits for the person's Continue, because a pane that navigates away at
 * the moment it turns into an answer is the jarring thing the operator
 * reported (2026-09-17; {@link handoffView} carries the whole history).
 *
 * The NON-WAITING title differs by family because the sentences do. A first
 * run is finishing; an onboarded machine whose server just came back was
 * never setting anything up, and telling it so would be the app narrating
 * its own state machine. The waiting title is family-blind by design — the
 * press is owed for any run this window executed, whichever family it
 * started in ({@link handoffView}).
 */
function renderHandoff(p: Probe): void {
  if (openFailed) {
    setFrame("none", "Subshell Is Running", "The dashboard did not open by itself.");
    el("bar-right").append(
      button(
        "Open Dashboard",
        () => {
          opened = false;
          openFailed = false;
          problem = "";
          render();
        },
        "primary",
      ),
    );
    return;
  }
  const view = handoffView({ onboarded: p.onboarded, ranSetupHere, continued });
  setFrame("none", view.title, view.subtitle);
  if (!view.wait) {
    openWhenReady();
    return;
  }
  // The checklist stays on screen, every row ticked. It is the answer to
  // "what did that just do", and on a machine that already had everything
  // it is the only chance to read it. The press is deliberately the plain
  // one — `openWhenReady` is the SAME call the auto path makes, so the
  // dashboard opening is identical whichever door it opens through.
  el("content").append(checklist(p, "active"));
  el("bar-right").append(
    button(
      "Continue",
      () => {
        continued = true;
        // The one stop AFTER the chain (operator's call, 2026-09-18): on a
        // Mac's first run this press hands off to the permissions screen
        // rather than to the dashboard, and that screen's own Continue does
        // what this one used to. `continued` is set either way — the handoff
        // is finished with, and leaving it false would bring this screen back
        // under the permissions one when the poll next rendered.
        if (permissionsAfterSetup({ platform: p.platform, ranSetupHere, ranFirstRunHere })) {
          permissionsAfterHandoff = true;
          // `go`, not a bare assignment: `replayEnter`'s own contract is that
          // EVERY screen change runs through it, so the SPA's replay behaviour
          // has exactly one native counterpart. Set directly, this was the one
          // transition in the app that arrived with no entrance animation.
          go("permissions");
          return;
        }
        render();
      },
      "primary",
    ),
  );
}

/**
 * The ONE screen a machine that has been set up sees while its server is not
 * answering (spec 2026-09-12 § 5.3). The title IS the diagnosis, there is one
 * primary action, and everything a person repairing an install would
 * otherwise have opened a console for sits behind Show Details.
 */
function renderRecovery(p: Probe): void {
  if (running) {
    renderProgress(p);
    return;
  }
  if (failure) {
    renderFailure(p);
    return;
  }
  setFrame("none", recoveryTitle(p.next), recoverySubtitle(p.next));
  const content = el("content");
  const action = recoveryAction(p.next);
  const tmuxMissing = p.tmux === null;
  if (action) {
    // The CLI refuses `init` and `service install` without tmux, so a button
    // that could only produce the refusal is disabled with its reason
    // directly below. Retry and Choose are not gated — neither runs a pane.
    const gated = tmuxMissing && action.kind !== "retry" && action.kind !== "choose-binary";
    content.append(button(action.label, () => runRecovery(action.kind), "primary big", gated));
  }
  // OFFERED here, never applied unasked: a newer bundled server is a choice,
  // and the screen someone reached because their server is down is exactly
  // where "the version you have may be the problem" belongs.
  if (p.serverChoice === "upgrade-available") {
    content.append(button(`Update Server to ${p.bundledVersion}…`, () => go("update"), "linkish"));
  }
  if (tmuxMissing) {
    tmuxWarn.applyPlan(tmuxInstallPlan(p.platform, p.hasBrew));
    tmuxWarn.hidden = false;
    content.append(tmuxWarn);
    // THIS screen can run the install too — `tmuxWarn`'s button goes through
    // the same `startTmuxInstall` — so it owes the same answer. The operator's
    // report was written from a first run, but the defect is the surface's
    // rather than the journey's: without this the recovery screen runs an
    // install and then says either one fragment of stderr on the problem line
    // or, for a run that exits zero and changes nothing, nothing at all. The
    // manual command is already covered here (`tmux-warning.ts` always shows
    // the line), which is what made the asymmetry worth closing rather than
    // scoping out.
    const failedHere = tmuxInstallFailure(tmuxResult, p.tmux !== null);
    if (failedHere !== null) content.append(tmuxFailureBlock(failedHere));
  }
  // Reachable HERE as well as from the dashboard, and that is the point: a
  // machine whose service definition is broken has no dashboard to open the
  // door from, and switching to app mode is one of the few things that can
  // get such a machine running again.
  content.append(button("Change how it runs…", () => go("supervision"), "linkish"));
  // Also reachable here, for the same reason: the dashboard is the ordinary
  // door to updating and a machine on this screen has no dashboard. It is
  // always offered rather than gated on a known update — nothing on THIS page
  // knows whether one exists until the screen behind it asks, and a row that
  // appeared only after an answer nobody had asked for would mean checking on
  // the poll.
  content.append(button("Check for updates…", () => go("update"), "linkish"));
  content.append(detailsDisclosure());
  // The ellipsis stays: it correctly says a screen follows rather than an act.
  el("bar-left").append(button(`${RESET_LABEL}…`, () => void openReset(), "ghost"));
}

/** Run the recovery screen's one action. Each is an existing path, named. */
function runRecovery(kind: RecoveryActionKind): void {
  switch (kind) {
    // A press that only re-probes still goes through `act`, so it disables
    // the screen and surfaces a refusal like every other press does.
    case "retry":
      void act(async () => null);
      return;
    case "choose-binary":
      void pickBinary();
      return;
    case "setup":
      void startSetup();
      return;
    case "install-service":
      void act(() => ipc.service("install", false), true);
      return;
    case "start":
      void act(() => ipc.service("start", false), true);
      return;
  }
}

/**
 * The pre-boot facts, the server's log and the last action's words, behind
 * one disclosure.
 *
 * All three were separate surfaces in the console — a Details list, a Logs
 * section, an output pane — reachable only by navigating away from the thing
 * that was wrong. They are one collapsed block under the diagnosis now, which
 * is the whole argument for a single recovery screen.
 */
function detailsDisclosure(): HTMLElement {
  const details = document.createElement("details");
  details.open = detailsOpen;
  details.addEventListener("toggle", () => {
    detailsOpen = details.open;
    // Pull a tail the moment it is asked for rather than waiting out the
    // poll: an empty pane on open reads as "there are no logs".
    if (detailsOpen) void refreshTail();
  });
  const summary = document.createElement("summary");
  summary.textContent = "Show Details";
  details.append(summary);

  const dl = document.createElement("dl");
  dl.className = "facts";
  for (const f of recoveryFacts(probe)) {
    const dt = document.createElement("dt");
    dt.textContent = f.label;
    const dd = document.createElement("dd");
    const line = text("span", f.value, f.tone === "bad" ? "bad-text" : f.tone === "warn" ? "warn-text" : "");
    dd.append(line);
    if (f.reveal) {
      const target = f.reveal;
      // Names an INTENT, never a path: the Rust side re-reads the path from
      // its own fresh probe, so a row can only reveal the fact it is showing.
      dd.append(button("Reveal", () => void ipc.openPath(target).catch(setProblem), "linkish"));
    }
    if (f.sub) dd.append(text("span", f.sub, "fact-sub"));
    dl.append(dt, dd);
  }
  details.append(dl);

  details.append(text("p", "Server log", "group-heading"));
  const log = document.createElement("pre");
  log.className = "pane-pre";
  renderTail(log, lastTail);
  details.append(log);

  const out = document.createElement("pre");
  out.className = "pane-pre";
  // Appended only when the last press actually said something: `.pane-pre:empty`
  // collapses the box, so a heading over nothing is the one shape to avoid.
  if (renderOutput(out, lastResult)) {
    details.append(text("p", "Last action", "group-heading"), out);
  }

  // The About block is gone (spec 2026-09-17 D6) — the terms, copyright and
  // the three links now live in the OS-standard About panel under the app
  // menu, which is where a person looks for them and where they crowd nothing.
  // What stays is the ONE fact that belongs HERE rather than there: the app's
  // version, sitting beside the server log a person is about to paste into a
  // bug report. It is also the only version no other surface knows on a
  // machine whose server is down — the SPA's About dialog needs the SPA.
  // The string is Rust's copy of the legal constants (`desktop_about`); the
  // page stores none of them.
  if (about !== null) {
    details.append(text("p", `This app — ${about.appName} ${about.appVersion}`, "detail"));
  }
  return details;
}

/**
 * Ask Rust whether a newer app exists, and re-render around the answer.
 *
 * @param force - a press of Check Again rather than the screen opening. It
 *   re-asks where a cached answer already exists; without it the screen's own
 *   first render would re-ask on every render, which is the poll this screen
 *   exists to stay off.
 */
async function runUpdateCheck(force: boolean): Promise<void> {
  if (updateState !== "idle") return;
  if (appUpdate !== null && !force) return;
  updateState = "checking";
  render();
  try {
    appUpdate = await ipc.checkAppUpdate();
  } catch (err) {
    // An `Err` here is the plugin refusing — a build with no public key, a
    // malformed endpoint — not "there is no update", which arrives as a
    // `reason`. It belongs on the problem line like every other refusal.
    setProblem(err);
    appUpdate = null;
  } finally {
    updateState = "idle";
    render();
  }
}

/**
 * Phase 1's app half: download, verify, install, write the marker, relaunch.
 *
 * Does not resolve on success: the app restarts out from under this page, and
 * the CLI half runs in the build that comes up (see {@link finishUpdate}). A
 * rejection is therefore always a real failure, which is why the `catch` puts
 * it on the problem line rather than treating it as a state to render.
 *
 * **Both arguments are the SELECTION** (spec § 13), and they are the only
 * things this press carries: `bundled` false writes no marker, so phase 2 does
 * not run at all, and `forced` is the Force box's answer to a restart that
 * happens in another process. Neither is re-derived on the far side — the
 * marker IS the record, which is what keeps one answer in one place.
 */
async function startAppUpdate(forced: boolean, bundled: boolean): Promise<void> {
  if (updateState !== "idle") return;
  updateState = "downloading";
  updateProgress = "Starting the download…";
  render();
  try {
    await ipc.installAppUpdate(forced, bundled);
  } catch (err) {
    setProblem(err);
    updateState = "idle";
    updateProgress = "";
    render();
  }
}

/**
 * The CLI half: install the server this app ships, then restart the service.
 *
 * Both phases end here — the act when the app is already current, and phase 2
 * after the relaunch — because it is the same two steps either way. What
 * differs is only the pane-safety answer, which the CALLER supplies, and the
 * difference is a consent rule rather than a mechanism:
 *
 * - **A PRESS consents to what this screen says now**, through the Force box
 *   under the table (spec § 13.2). Unticked is an ordinary restart, which the
 *   CLI refuses where the definition would close live panes — and that refusal
 *   renders here, with the box still on screen to answer it.
 * - **The automatic resume consents to nothing new.** It carries the answer
 *   phase 1 recorded (`pendingInstall.forced`), because the person who pressed
 *   Update is not at this window and cannot be asked again. Where the
 *   definition has changed under it the CLI refuses, this screen shows that
 *   refusal verbatim, and the Try Again under the fresh box is where the new
 *   consent comes from.
 *
 * **A REJECTION is recorded as a result too**, which is not bookkeeping: `act`
 * turns a throw into the problem line and leaves `updateResult` null, and null
 * reads to the screen as "nothing has been attempted in this window" — so the
 * finishing phase showed an error line under "Installing the server it ships…"
 * with no Try Again, and with the automatic fire already latched for the visit
 * there was nothing left to press (review, 2026-09-18). The throw is re-raised
 * so `act` still says what went wrong.
 */
async function finishUpdate(_p: Probe, forced: boolean): Promise<void> {
  await act(async () => {
    try {
      const installed = await ipc.installServer();
      updateResult = installed;
      if (!installed.ok) return installed;
      // `--force` only where the definition would refuse over live panes; the
      // CLI rejects the flag on every other verb.
      const restarted = await ipc.service("restart", forced);
      updateResult = restarted;
      return restarted;
    } catch (err) {
      updateResult = rejectedResult(errText(err));
      throw err;
    }
  }, true);
}

/**
 * **Update Subshell Server** — the app AND the server it ships, in one act
 * (spec 2026-09-18).
 *
 * There were two screens here, *Update Your Server* and *Update Subshell
 * Server*, and they were never two acts: every desktop bundle SHIPS the CLI it
 * wraps, so installing the app is what makes a newer server available, and the
 * old pair asked a person to do our packaging's bookkeeping. The names differed
 * by a possessive.
 *
 * **It is two phases, separated by the relaunch** and by nothing else. Phase 1
 * downloads and installs the application and writes a marker; the build that
 * comes up reads that marker, opens this screen in its finishing state, and
 * installs the bundled server. The order is forced rather than chosen: the new
 * app carries the newer server, so installing the server first installs the
 * OUTGOING bundle's copy and leaves the machine behind again the moment the app
 * lands.
 *
 * Reached from the tray, from the recovery screen's footer, and from the SPA
 * (`desktop_open_assistant({ screen: "update" })` — a screen name, and zero new
 * grants on `main`). It renders over a RUNNING server, which is why `render()`
 * lets a requested screen outrank the ready handoff.
 *
 * **It is a SELECTION, not always both halves** (spec § 13). An operator at
 * app 0.8.1 with a hand-updated `subshell-server` 0.10.1 was told the screen
 * wanted to install a server older than the one they were running: the CLI row
 * was pushed whenever the app was behind, while the ladder would have ADOPTED
 * the installed copy and installed nothing. So both components get a row, each
 * carrying a checkbox where there is something to do and the reason where there
 * is not, and one press runs what is ticked — which, with both halves behind,
 * is still both halves under one press.
 *
 * **Every judgment is in `lib/update-act.ts`**, which is pure and tested; what
 * is left here is the DOM, the ticks, and the two presses.
 */
function renderUpdate(p: Probe): void {
  const view = updateAct({
    probe: p,
    appUpdate,
    state: updateState,
    finished: updateResult,
    selection: updateSelection,
  });
  setFrame("none", UPDATE_TITLE, view.subtitle);
  const content = el("content");

  // The selection table (spec § 13.1). One line per component: what it runs,
  // what it would become, and either a checkbox or the reason there is none.
  const locked = busy || updateState !== "idle";
  for (const row of view.rows) {
    const id = `update-row-${row.id}`;
    // A `<label>` only where there is a control to label — a label pointing at
    // nothing is a click target that does nothing.
    const line = document.createElement(row.selected === null ? "div" : "label");
    line.className = "update-row";
    if (line instanceof HTMLLabelElement) line.htmlFor = id;
    const copy = document.createElement("div");
    copy.append(text("div", row.label, "label"));
    // A null target on a row that CAN act is the one number this build cannot
    // know: only the new bundle knows which server it carries (§ 4.3). On a row
    // that cannot act there is nothing it becomes, so the arrow goes with it.
    const versions =
      row.to !== null
        ? `${row.from} → ${row.to}`
        : row.selected !== null
          ? `${row.from} → the server it ships`
          : row.from;
    copy.append(text("div", versions, "hint"));
    line.append(copy);
    if (row.selected === null) {
      // The reason renders in the cell the checkbox would have occupied, and
      // there is deliberately no disabled checkbox to render it beside: "not
      // now" without a why is exactly what § 13 removed.
      if (row.reason !== null) line.append(text("span", row.reason, "update-reason"));
    } else {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = id;
      box.checked = row.selected;
      box.disabled = locked;
      box.addEventListener("change", () => {
        updateSelection = { ...updateSelection, rows: { ...updateSelection.rows, [row.id]: box.checked } };
        render();
        refocus(id);
      });
      line.append(box);
    }
    content.append(line);
  }

  if (updateProgress !== "") content.append(text("p", updateProgress, "hint"));
  // The last run's own words, wherever it stopped. Phase 2 has no other way to
  // report itself — nobody pressed anything, so a silent failure would be a
  // screen that says "installing…" forever.
  if (view.phase === "halted" || (updateResult !== null && !updateResult.ok)) {
    const out = document.createElement("pre");
    out.className = "pane-pre";
    if (renderOutput(out, updateResult)) content.append(out);
  }

  for (const note of view.notes) content.append(text("p", note, "hint"));

  // The Force box, under the table it governs (§ 13.2). The amber sentence
  // states what the restart costs; the box beside it is the only refusal on
  // this screen a person may overrule — never the downgrade the adopt-installed
  // row explains, which no box may perform.
  if (view.force !== null) {
    const force = view.force;
    content.append(text("p", force.warning, "hint warn-text"));
    const line = document.createElement("label");
    line.className = "switch update-force";
    line.htmlFor = "update-force";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "update-force";
    box.checked = force.checked;
    box.disabled = locked;
    box.addEventListener("change", () => {
      updateSelection = { ...updateSelection, force: box.checked };
      render();
      refocus("update-force");
    });
    line.append(box, text("span", force.label, "label"));
    content.append(line);
  }

  if (view.press !== null) {
    const press = view.press;
    if (press.kind === "app") {
      content.append(
        text(
          "p",
          press.bundled
            ? "The update is downloaded, its signature is checked against the key built into this app, and then " +
                "Subshell Server restarts and installs the server it ships. Open subshells keep running throughout."
            : "The update is downloaded, its signature is checked against the key built into this app, and then " +
                "Subshell Server restarts. The server on this machine is left as it is.",
          "hint",
        ),
      );
      // Linux installs through dpkg, which raises a system password sheet. A
      // sheet nobody was told about reads as malware, which is the whole reason
      // this sentence is here and is platform-branched — a genuine difference in
      // what the user has to DO, not in voice.
      if (p.platform === "linux") {
        content.append(
          text("p", "Linux installs the package with dpkg, so your system will ask for your password.", "hint"),
        );
      }
    }
    content.append(
      button(
        press.label,
        () =>
          press.kind === "app" ? void startAppUpdate(press.forced, press.bundled) : void finishUpdate(p, press.forced),
        "primary big",
        !press.enabled,
      ),
    );
  }

  // The automatic half of phase 2 — the only thing on this page that acts
  // without a press, and it is the SECOND half of a press already made. Fired
  // once per VISIT to this screen (`applyScreen` clears the latch), like the
  // first run's chain: the poll re-renders twice a second, and what bounds
  // automatic RETRIES is the marker's own attempt count, not this. It carries
  // the consent the marker recorded rather than anything on screen — nobody is
  // here to answer, which is the whole of § 5's argument. Deferred for the
  // reason {@link afterRender} gives.
  if (view.phase === "finishing" && view.press === null && !resumeFired) {
    resumeFired = true;
    const forced = p.pendingInstall?.forced ?? false;
    afterRender(() => void finishUpdate(p, forced));
  }

  el("bar-left").append(button("Not Now", () => host.close(), "ghost"));
  // Hidden while anything is in flight: re-checking mid-act asks a question
  // nothing will read, and closing this window out from under a running
  // download is how the app would quit mid-update.
  if (updateState === "idle" && !busy && view.phase !== "finishing") {
    el("bar-right").append(button("Check Again", () => void runUpdateCheck(true), "ghost"));
    // **Later** (spec 2026-09-17 § 5.4): the update stays exactly where it
    // is, and so does this window's part in remembering it — no state, no
    // snooze. The dismissal that DOES exist lives per app run in the SPA
    // row's sessionStorage, and the tray item is not dismissed away at all:
    // it is a request surface, not a notification.
    el("bar-right").append(button("Later", () => void closeAssistantWindow(), "ghost"));
  }
}

/**
 * Close this window through the Tauri core window API — the one page action
 * that is about the WINDOW rather than the machine, which is why it goes
 * around `lib/ipc.ts`: the exact-set pins there are about the `desktop_*`
 * commands, and this invokes no command of ours. The grant lives in
 * `capabilities/wizard.json` (`core:window:allow-close`), and
 * `ipc-acl.test.ts` pins the wizard window's core grants to exactly
 * `core:default` plus it.
 */
function closeAssistantWindow(): void {
  void getCurrentWindow().close().catch(setProblem);
}

/**
 * **What macOS Will Ask** (spec 2026-09-14 § 3) — reached TWO ways, both of
 * them requests.
 *
 * Spec 2026-09-17 (D3) took it off the first run, on the grounds that a
 * dashboard detection notice is the better door: the screen appears when a
 * permission is actually missing, next to the notice that says so, rather
 * than four screens before anything needs one. That door is unchanged. The
 * 2026-09-18 operator report added the second (spec § 10): on a Mac's first
 * run the ready screen's Continue hands off HERE before the dashboard, once,
 * because macOS asks each of these exactly once and a first run that goes
 * straight to a sign-in page has spent the one moment when explaining them is
 * cheap. It is still after the chain, so D1's zero-touch first run is intact.
 *
 * Both doors NAME the screen — `permissions` never left `REQUESTED_SCREENS`
 * — so `isRequestedScreen` remains the whole routing and there is still one
 * way in. See {@link permissionsAfterSetup} for the three conditions on the
 * second one.
 *
 * It exists because macOS asks each of these exactly ONCE, unannounced, and
 * attributes some of them to a binary the person never typed. Declining is one
 * click and there is no second prompt, after which the product simply goes
 * quiet — no notification when an agent is waiting, an empty folder in the
 * picker, an image that does not attach — with nothing anywhere saying why.
 * Saying it first is the cheapest fix there is.
 *
 * **Nothing here blocks.** Every row answers in its own state and no Continue
 * gates anything: declining is a legitimate answer, and this screen is also
 * the way back from one, so gating the flow on an allow would make the
 * recovery path unreachable from the only place that offers it.
 *
 * **The bottom bar says which door it came through.** From a notice there is
 * somewhere to go back TO, and Back closes the screen for whatever the probe
 * implies, exactly as the supervision screen's does. From the handoff there
 * is not — this window's whole remaining job is to open the dashboard — so it
 * carries a primary Continue that does it, and a Back there would be the
 * button lying about where it leads.
 */
function renderPermissions(p: Probe): void {
  setFrame("none", "What macOS Will Ask", "Three things, each once. Here is what they are for.");
  const content = el("content");
  const ul = document.createElement("ul");
  ul.className = "checklist";
  for (const row of permissionRows(p, { notifications: requestingNotifications, photos: requestingPhotos })) {
    const li = document.createElement("li");
    li.dataset.state = row.state;
    // The setup checklist's own glyphs, deliberately: "allowed" should look
    // the same wherever this app says it, and a second visual language for
    // done and failed is how two screens come to disagree about a tick.
    const glyph = text("span", row.state === "done" ? "✓" : row.state === "failed" ? "✕" : "", "glyph");
    const copy = document.createElement("div");
    copy.className = "permission-copy";
    copy.append(text("div", row.label, "label"), text("div", row.detail, "detail"));
    const side = document.createElement("div");
    side.className = "permission-side";
    if (row.suffix) side.append(text("span", row.suffix, "detail"));
    // Both the WORDS and the handler come from the row. These were hardcoded
    // to notifications when it was the only row that could ask anything; with
    // Photos asking too, the label would put one permission's name on a button
    // that spends the other's question. `REQUESTS` is a `Record` over the
    // model's closed union, so a request added there without its handler here
    // is a type error rather than a silent mis-wiring.
    const allow = row.allow;
    if (row.action === "allow" && allow) side.append(button(allow.label, () => REQUESTS[allow.request](), "primary"));
    if (row.action === "open-settings" && row.pane !== null) {
      const pane = row.pane;
      // No `ghost`: on the tmux screen that treatment read as a link and did
      // not say it could be pressed, and this is the one control a person
      // arrives here specifically to find.
      side.append(button("Open System Settings", () => void ipc.openSystemSettings(pane).catch(setProblem)));
    }
    li.append(glyph, copy, side);
    ul.append(li);
  }
  content.append(ul);
  // Two doors, and the button says which one it came through. From a
  // dashboard notice there is somewhere to go back TO, and Back drops the
  // screen for whatever the probe implies. From the ready handoff there is
  // not: this window's whole remaining job is to open the dashboard, so the
  // press is a Continue that does it — a "Back" there would be the button
  // lying about where it leads.
  if (permissionsAfterHandoff) {
    el("bar-right").append(
      button(
        "Continue",
        () => {
          permissionsAfterHandoff = false;
          host.close();
        },
        "primary",
      ),
    );
    return;
  }
  el("bar-left").append(button("Back", () => host.close(), "ghost"));
}

/**
 * Ask macOS, once.
 *
 * The flag is set BEFORE `act` so the very first render of the busy state
 * already shows the row spinning; `act` renders on entry, and setting it
 * inside the callback would leave one frame of a disabled button over a
 * pending row. The early return mirrors `act`'s own, or a press that `act`
 * ignored would leave the row spinning for the rest of the session.
 *
 * The RESULT is thrown away on purpose (spec § 3.1): the row renders from
 * `probe.notificationPermission`, which the poll refreshes, so there is one
 * source for what this machine allows. A rejection still surfaces — `act`
 * puts it in the problem line.
 */
function allowNotifications(): void {
  if (busy || running) return;
  requestingNotifications = true;
  void act(async () => {
    try {
      await ipc.requestNotifications();
    } finally {
      requestingNotifications = false;
    }
    return null;
  });
}

/**
 * Ask macOS for Photos, once — [`allowNotifications`] in every way that
 * matters, including the discarded result: this row renders from
 * `probe.photosPermission`, which the poll refreshes.
 *
 * What it raises is the sheet the image picker would have raised for itself,
 * so pressing this is not asking macOS a favour — it is moving the same
 * question to a screen that has already explained it (spec 2026-09-14 § 9, as
 * amended by the operator on 2026-09-17; `request_photos`'s docblock in
 * `desktop-core` carries the reasoning).
 */
function allowPhotos(): void {
  if (busy || running) return;
  requestingPhotos = true;
  void act(async () => {
    try {
      await ipc.requestPhotos();
    } finally {
      requestingPhotos = false;
    }
    return null;
  });
}

/**
 * Which handler each row's `allow` button reaches.
 *
 * A `Record` over the model's closed union rather than a chain of `if`s on
 * `row.id`: adding a third request to `PermissionRequest` without naming it
 * here is a compile error, where a dispatch that defaults would route it to
 * notifications and render a button that lies.
 */
const REQUESTS: Record<PermissionRequest, () => void> = {
  notifications: allowNotifications,
  photos: allowPhotos,
};

/**
 * **How Your Server Runs** — reached from the recovery screen's link, never
 * from `screensFor`: it is a question a person asks, not one a probe implies.
 *
 * It exists for the machine that has NO dashboard to ask on — a broken
 * service definition, a server that will not start — where switching to app
 * mode is one of the few things that can get it running again. A machine
 * with a working dashboard asks there instead: the Service page has its own
 * dialog and calls `desktop_set_supervision` directly (2026-09-12).
 */
function renderSupervision(p: Probe): void {
  setFrame("none", "How Your Server Runs", "Change who starts it, and when.");
  const content = el("content");
  const chosen = supervisionForm ?? {
    background: p.supervision !== "app",
    autostart: p.service?.enabled === true,
  };
  supervisionForm = chosen;

  const option = (opts: { id: string; on: boolean; title: string; body: string; onPick: () => void }): HTMLElement => {
    const row = document.createElement("label");
    row.className = "choice-row";
    row.htmlFor = opts.id;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "supervision-mode";
    radio.id = opts.id;
    radio.checked = opts.on;
    radio.disabled = busy || running;
    radio.addEventListener("change", () => {
      opts.onPick();
      render();
      refocus(opts.id);
    });
    const copy = document.createElement("div");
    copy.append(text("div", opts.title, "label"), text("div", opts.body, "hint"));
    row.append(radio, copy);
    return row;
  };

  content.append(
    option({
      id: "sup-service",
      on: chosen.background,
      title: "In the background",
      body:
        p.platform === "darwin"
          ? "A launchd agent runs it, even when this app is closed."
          : "A systemd user service runs it, even when this app is closed.",
      onPick: () => {
        supervisionForm = applySupervisionChoice(chosen, { background: true });
      },
    }),
  );
  // Nested under the option it belongs to, and only live while that option is
  // the one selected — arming login means nothing without a service.
  const login = document.createElement("label");
  login.className = "choice-sub";
  login.htmlFor = "sup-login";
  const loginBox = document.createElement("input");
  loginBox.type = "checkbox";
  loginBox.id = "sup-login";
  loginBox.checked = chosen.autostart && autostartSupported(p);
  loginBox.disabled = !chosen.background || !autostartSupported(p) || busy || running;
  loginBox.addEventListener("change", () => {
    supervisionForm = applySupervisionChoice(chosen, { autostart: loginBox.checked });
    render();
    refocus("sup-login");
  });
  login.append(loginBox, text("span", "Start it again at every login", "label"));
  if (chosen.background && autostartSupported(p)) {
    login.append(text("span", "Otherwise it stays stopped after you log out.", "hint"));
  }
  if (!autostartSupported(p)) {
    login.append(text("span", `Update your server to ${MIN_AUTOSTART_SERVER_VERSION} to control this.`, "hint"));
  }
  content.append(login);

  content.append(
    option({
      id: "sup-app",
      on: !chosen.background,
      title: "With this app",
      body: "Runs while Subshell Server is open; quitting stops it. Running subshells keep running.",
      onPick: () => {
        supervisionForm = applySupervisionChoice(chosen, { background: false });
      },
    }),
  );

  if (failure) {
    // The CLI's own words where the person still is, styled as a failure —
    // the same treatment the reset screen's half-run log gets, so two
    // surfaces never phrase one outcome differently.
    const box = document.createElement("pre");
    box.className = "output";
    if (renderOutput(box, failure)) content.append(box);
  }

  const current = { background: p.supervision !== "app", autostart: p.service?.enabled === true };
  const unchanged = current.background === chosen.background && current.autostart === chosen.autostart;
  el("bar-left").append(button("Back", () => host.close(), "ghost"));
  el("bar-right").append(
    button(
      "Apply",
      () =>
        void act(async () => {
          const result = await ipc.setSupervision(chosen.background ? "service" : "app", chosen.autostart);
          // Leaving IS the confirmation: this screen's whole subject is a
          // choice, and staying on it with a greyed-out Apply is the only
          // feedback a success would otherwise get. A failure keeps the
          // screen, where its log has just been rendered.
          if (result.ok) host.close();
          return result;
        }, true),
      "primary",
      unchanged || busy || running,
    ),
  );
}

/**
 * Whether focus is somewhere a redraw would destroy typing.
 *
 * The poll skips a render while a hand is in an input — but a CHECKBOX is an
 * `HTMLInputElement` too, and treating one as text froze the setup screen's
 * progress checklist for the whole chain whenever someone tabbed to a box
 * without toggling it. Only text-like inputs hold anything a redraw can lose.
 */
function isTextEntry(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !["checkbox", "radio", "button", "submit"].includes(el.type);
}

/**
 * Put focus back on a control a re-render just destroyed.
 *
 * `render()` rebuilds `#content`, so every toggle drops focus to `<body>` —
 * which breaks the standard interaction for both new surfaces: arrow keys
 * between two radios fire `change`, lose focus, and the next arrow key does
 * nothing. The address form solves the same problem by replacing one subtree
 * rather than re-rendering; these controls are cheap enough to rebuild, so
 * they restore focus by id instead.
 */
function refocus(id: string): void {
  document.getElementById(id)?.focus();
}

/** Arm a plan and raise the Reset screen. */
async function openReset(): Promise<void> {
  screen = "reset";
  // `open()` shows the screen whether or not a plan staged: the screen is
  // what explains a refusal.
  await resetView.open();
}

function renderFailure(p: Probe): void {
  setFrame("none", "Setup Couldn't Finish", "Nothing else was changed.");
  const content = el("content");
  content.append(checklist(p, "failed"));
  if (failure) {
    const details = document.createElement("details");
    // The openness is PAGE state, for the same reason the recovery screen's
    // is: `#content` is rebuilt on every render and the poll renders every
    // 1500 ms, so a `<details>` that kept its state only in the DOM collapsed
    // under the reader twice a second. It did exactly that until now.
    details.open = detailsOpen;
    details.addEventListener("toggle", () => {
      detailsOpen = details.open;
    });
    const summary = document.createElement("summary");
    summary.textContent = "Show Details";
    const pre = document.createElement("pre");
    pre.className = "pane-pre output-bad";
    pre.textContent = [failure.stdout.trim(), failure.stderr.trim()].filter(Boolean).join("\n\n");
    details.append(summary, pre);
    content.append(details);
  }
  // "Open Status Page" used to be here and on the ready screen, opening the
  // console. There is no second window to offer: this page IS the status
  // page now, and a failed chain leaves the reader on the screen that
  // explains it (spec 2026-09-12 § 5.1).
  el("bar-right").append(button("Try Again", () => void startSetup(), "primary"));
}

/** The five-row checklist; the first not-done row takes `undoneState`. */
function checklist(p: Probe, undoneState: "active" | "failed"): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "checklist";
  // NOT `form.port`/`form.host` raw: on the auto-fired chain the form never
  // rendered, and the row would read "port 3080" off a machine the chain
  // just left on its stored 4000 — under a subtitle vouching for the list.
  const rows = setupRows(p, checklistAddresses(p, form), supervision);
  const first = rows.find((r) => !r.done);
  for (const row of rows) {
    const li = document.createElement("li");
    li.dataset.state = row.done ? "done" : row === first ? undoneState : "pending";
    const glyph = text("span", row.done ? "✓" : row === first && undoneState === "failed" ? "✕" : "", "glyph");
    li.append(glyph, text("span", row.label, "label"), text("span", row.detail, "detail"));
    if (row === first && undoneState === "failed" && failure) li.append(text("div", failureLine(failure), "sub"));
    ul.append(li);
  }
  return ul;
}

function addressForm(p: Probe): HTMLElement {
  if (!seeded) {
    const s = effectiveForm(p.status?.settings);
    for (const { name } of CONFIG_FIELDS) form[name] = form[name] || s[name];
    for (const [name, on] of Object.entries(explicitFields(p.status?.settings)) as [keyof ExplicitMap, boolean][]) {
      if (on) explicit[name] = true;
    }
    seeded = true;
  }
  const grid = document.createElement("div");
  grid.className = "mt-4 grid w-full grid-cols-2 gap-2.5";
  for (const field of CONFIG_FIELDS) {
    const cell = document.createElement("div");
    if (field.wide) cell.className = "col-span-2";
    const label = document.createElement("label");
    label.htmlFor = `field-${field.name}`;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = `field-${field.name}`;
    input.value = form[field.name];
    input.placeholder = field.placeholder;
    input.spellcheck = false;
    input.autocapitalize = "off";
    if (field.numeric) input.inputMode = "numeric";
    input.addEventListener("input", () => {
      form[field.name] = input.value;
      explicit[field.name] = true;
      if (field.name === "port") {
        if (explicit.baseUrl !== true) {
          form.baseUrl = derivedBaseUrl(input.value);
          const mirror = document.getElementById("field-baseUrl") as HTMLInputElement | null;
          if (mirror) mirror.value = form.baseUrl;
        }
        // Ask about the new number now rather than at the next render. The
        // poll skips a tick while a text field has focus (`tick()`), so
        // without this the answer for a port someone just typed would not
        // start being measured until they left the field — and the screen
        // would keep naming the old conflict while they looked at the fix.
        checkPort(chosenPort(p));
      }
      // Two things mirror the port as it is typed: the baseUrl field,
      // updated in place above, and the dashboard row at the top of the
      // screen — neither may force a re-render, which would take the cursor
      // out of the field mid-keystroke. The next poll's render picks the
      // values up from `form` regardless.
      if (field.name === "port" || field.name === "baseUrl") syncDashboardUrl(p);
    });
    cell.append(label, input);
    if (field.hint) cell.append(text("p", field.hint, "hint"));
    for (const pe of fieldProblems(p.status?.settings, field.name)) cell.append(text("p", pe.reason, "hint warn-text"));
    grid.append(cell);
  }
  return grid;
}
function resetForm(): void {
  for (const { name } of CONFIG_FIELDS) {
    form[name] = "";
    delete explicit[name];
  }
  seeded = false;
}

// ---------------------------------------------------------------------------
// Navigation, actions, render, poll
// ---------------------------------------------------------------------------
/**
 * Restarts the screen's entrance animation: `.enter`'s `animation` only fires
 * on insertion, so a class already present needs a forced reflow between
 * removing and re-adding it. The one place that does this — every screen
 * change, manual or automatic, goes through it (see {@link go} and the
 * automatic-advance branch in {@link render}) so the SPA's replay behaviour
 * (spec § 5.2, § 3) has exactly one native counterpart to match.
 */
function replayEnter(): void {
  const s = el("screen");
  s.classList.remove("enter");
  void s.offsetWidth; // restart the animation
  s.classList.add("enter");
}
function go(to: ScreenId): void {
  screen = to;
  replayEnter();
  render();
}

/** Pull a fresh tail for the Show Details pane. Failure leaves the last one. */
async function refreshTail(): Promise<void> {
  try {
    lastTail = await ipc.logs();
  } catch {
    return;
  }
  render();
}

/**
 * Run one press: nothing else may run beside it, the screen always re-renders,
 * and a rejection is surfaced rather than leaving every control disabled.
 *
 * `settle` asks for the extra re-probes. Pass it when the whole POINT of the
 * press is a running server (install, start, update): `service start` returns
 * when the manager has spawned the process, not when the port is bound, so a
 * single re-probe reads "installed but not running" on a server that came up
 * fine — and the recovery screen would snap back to the diagnosis the press
 * had just fixed.
 */
/**
 * Run something THIS RENDER asked for, after the render has finished.
 *
 * `render()` starts by clearing `#content` and both bars and then rebuilds
 * them, and everything scheduled here calls `render()` on its own first line —
 * so firing one from inside a render re-enters it, and the outer render, which
 * is still part-way down its own body, appends a SECOND copy of everything
 * below the call site.
 *
 * That is not hypothetical: the app-update screen shipped with it. Its first
 * render kicked the release check, which set its state and re-rendered from
 * inside the arm that had not drawn yet, and the screen was drawn twice into
 * one frame. It was survivable there only because the poll redraws 1500 ms
 * later and the duplicated screen was one line of text.
 *
 * A microtask runs after the current render returns and before the next paint,
 * so nothing flickers and nothing re-enters.
 */
function afterRender(fn: () => void): void {
  queueMicrotask(fn);
}

async function act(fn: () => Promise<ActionResult | null>, settle = false): Promise<void> {
  if (busy || running) return;
  busy = true;
  problem = "";
  lastResult = null;
  render();
  try {
    const r = await fn();
    lastResult = r;
    if (r && !r.ok) problem = failureLine(r);
  } catch (err) {
    problem = errText(err);
  }
  await refresh().catch(setProblem);
  for (let i = 0; settle && i < 2 && probe?.next !== "ready"; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    await refresh().catch(() => {});
  }
  busy = false;
  installStartedAt = 0;
  stopInstallClock();
  render();
}

/**
 * How long a successful setup chain waits for the server to answer before it
 * stops holding the progress screen up.
 *
 * Generous on purpose: the cost of being too short is the run visibly going
 * backwards into a question already answered, and the cost of being too long
 * is a spinner on a machine that has genuinely failed — which the recovery
 * family is built to explain anyway, on the next launch.
 */
const SETTLE_BUDGET_MS = 30_000;

async function startSetup(): Promise<void> {
  if (busy || running || probe === null) return;
  running = true;
  failure = null;
  problem = "";
  // A new run earns its own dismissal. `continued` latches the ready screen's
  // press for the window; leaving it set would let a SECOND chain — a retry
  // after a failed open, or a dev-build reset that redrew first run in place
  // — auto-navigate on the FIRST visit's press, which is the skipped-press
  // bug back. `ranSetupHere` is NOT cleared: a completed chain that ran here
  // is still one that ran here, and the flag is what gates showing the result.
  continued = false;
  // Captured HERE because it cannot be read later: the probe flags
  // `onboarded` on the very `ready` this chain is about to produce, so by the
  // time the handoff asks, every machine looks like one that had been set up
  // before. See {@link permissionsAfterSetup}, which is its one reader.
  ranFirstRunHere = !probe.onboarded;
  render();
  let result: ActionResult | null = null;
  try {
    result = await ipc.setup({ ...configPayload(form, explicit), supervision });
    if (result && !result.ok) failure = result;
    await refresh().catch(() => {});
    if (result?.ok) {
      // `service start` returns when the manager has SPAWNED the process, not
      // when the port is bound — so a successful chain routinely lands here
      // with the machine not yet ready, and this waits for it.
      //
      // It used to be two looks, three seconds. Past that the chain declared
      // itself over, `running` cleared, and `renderSetup` fell back to the
      // supervision question the person had just answered — then the next
      // poll found `ready` and jumped to the account form. Forwards,
      // backwards, forwards, on every machine slower than three seconds.
      //
      // A deadline instead of a count, and long enough to cover a cold start
      // rather than a warm one. It is still BOUNDED: a server that never
      // answers has to leave the person somewhere with a button, and that
      // somewhere is the setup screen this returns to.
      const readyBy = Date.now() + SETTLE_BUDGET_MS;
      while (probe?.next !== "ready" && Date.now() < readyBy) {
        await new Promise((r) => setTimeout(r, 750));
        await refresh().catch(() => {});
      }
    }
  } catch (err) {
    problem = errText(err);
  } finally {
    // A chain that ran here earns the ready screen a button (see
    // `handoffView`). Recorded even when the settle loop timed out: the
    // person still deserves to be shown where it got to, rather than the
    // window deciding on their behalf — and a slow machine that reaches
    // `ready` one poll later lands on the same waiting screen.
    if (result?.ok) ranSetupHere = true;
    // CLEARED LAST, after the settle loop — not the moment `setup` returns.
    // `running` is what holds the progress screen up, and `renderSetup` falls
    // back to the CONFIG screen without it. Clearing it early left up to
    // three seconds in which the poll (which runs precisely because this flag
    // is set) re-rendered the question the person had just answered, and the
    // run visibly went forwards, backwards, then forwards again into the
    // account form.
    running = false;
  }
  render();
}

async function pickBinary(): Promise<void> {
  const chosen = await openDialog({ multiple: false, directory: false, title: "Choose subshell-server" });
  if (!chosen) return; // a cancel must not clear the stored choice
  await act(async () => {
    await ipc.setServerBin(chosen);
    return null;
  });
}

function openWhenReady(): void {
  if (opened || probe?.next !== "ready") return;
  opened = true;
  void ipc.openMain().catch((e: unknown) => {
    openFailed = true;
    setProblem(e);
  });
}
function setProblem(err: unknown): void {
  problem = errText(err);
  render();
}

function render(): void {
  el("problem").textContent = problem;
  clear("content", "bar-left", "bar-right");
  // Reset replaces the frame rather than filling it, so nothing below runs.
  if (resetView.isOpen()) {
    resetView.render();
    return;
  }
  if (probe === null) {
    setFrame("icon", "Welcome to Subshell", "Checking this machine…");
    return;
  }
  const p = probe;
  // A REQUESTED screen outranks the probe's own family — BOTH of them, which
  // is the rule `isRequestedScreen` states beside `screensFor`. The SPA
  // deep-links here on a machine whose server is running (Update from its
  // card, Reset from its danger card, Permissions from any of the detection
  // notices), the tray opens the update screen, the BOOT resume opens it to
  // finish an update that spans a relaunch, and the ready handoff below would
  // otherwise send the window straight back to the dashboard it was just asked
  // to leave.
  //
  // `update` draws itself here. `reset` does not: its screen replaces the
  // frame from `resetView` at the top of this function. Since `open()` shows
  // BEFORE it arms, `isOpen()` is true from the moment the request is applied
  // and that check catches reset first — so this arm is defence in depth for
  // that screen rather than its only guard, and it stays because the rule is
  // "a requested screen outranks the probe's family", which should not have
  // to be re-derived if `open()` ever awaits again.
  const list = screensFor(p, p.onboarded);
  // No screen is BOTH requestable and a journey step since spec 2026-09-17
  // took `permissions` off the first run, so the request alone routes — the
  // `!list.includes(screen)` disambiguation this call site used to carry has
  // nothing left to disambiguate.
  if (isRequestedScreen(screen)) {
    if (screen === "update") {
      // The check is kicked off from the render rather than from the routing,
      // because every door — the tray item on both of its labels, the SPA's
      // deep link, and the boot resume — arrives through `screen`, and a
      // second place that started it is a second place to forget.
      // `runUpdateCheck(false)` is a no-op once an answer exists, so the
      // poll's re-renders cost nothing.
      //
      // NOT while a marker is pending: phase 2 is about installing the server
      // the app it just installed ships, and asking a third party whether a
      // newer app exists is both irrelevant and the one thing on this screen
      // that can hang for 20 seconds.
      if (p.pendingInstall === null) afterRender(() => void runUpdateCheck(false));
      renderUpdate(p);
    }
    if (screen === "supervision") renderSupervision(p);
    if (screen === "permissions") renderPermissions(p);
    return;
  }
  if (list.length === 0) {
    // The progress screen owns the window while the chain runs, READY PROBE
    // OR NOT. The poll ticks precisely because `running` is set, and the
    // port binds before `startSetup`'s finally records `ranSetupHere` — a
    // tick landing inside that window would render the handoff with the flag
    // still false, and `handoffView` would auto-open: the skipped press this
    // screen exists to prevent. Same guard `renderSetup` and `renderRecovery`
    // run; the ready branch is where a chain's last seconds are spent.
    if (running) {
      renderProgress(p);
      return;
    }
    // Ready, in either family: the dashboard is what comes next. The replay
    // is triggered HERE because no button press routed through `go()` — and
    // it is guarded, because `next === "ready"` stays true on every later
    // poll and an unguarded replay fired every 1500 ms forever, visibly on
    // the `openFailed` screen, which stays up indefinitely.
    if (!handedOff) {
      handedOff = true;
      screen = null;
      replayEnter();
    }
    renderHandoff(p);
    return;
  }
  handedOff = false;
  // Resolve `null`, and correct a screen the probe no longer offers. This one
  // re-resolution IS the tmux advance now, and the only one: `screensFor`
  // holds `tmux` exactly while it is missing, so the render that first sees a
  // tmux finds `tmux` no longer on the list, lands on `setup`, and the chain
  // fires. It used to be a second, independent auto-jump inside this function
  // — the defect was never the advancing, it was advancing by a rule the
  // screen list could not see and Back could not survive. A machine that
  // finishes its first run becomes onboarded, and "setup" is not on the
  // recovery family's list; same mechanism, same correction.
  if (screen === null) {
    screen = list[0] ?? "setup";
  } else if (!list.includes(screen)) {
    // A correction, not a greeting: the reader already pressed past the
    // welcome, so a probe change must not land them back on it. This is the
    // tmux-found advance — the list drops `tmux` mid-screen and the render
    // walks to the ACT, where the chain fires. `list[0]` was that answer
    // until Welcome returned to the head of the list on 2026-09-18.
    screen = (list[0] === "welcome" ? list[1] : list[0]) ?? "setup";
  }
  type JourneyScreen = "welcome" | "tmux" | "setup" | "recovery";
  const views: Record<JourneyScreen, () => void> = {
    welcome: () => renderWelcome(p),
    tmux: () => renderTmux(p),
    setup: () => renderSetup(p),
    recovery: () => renderRecovery(p),
  };
  // `screen` is one of the four by construction — `list` only ever holds
  // those — and the fallback exists so a family added later is the screen
  // that diagnoses rather than a blank window on a machine someone is
  // repairing.
  (views[screen as JourneyScreen] ?? (() => renderRecovery(p)))();
}

async function refresh(): Promise<void> {
  probe = await ipc.probe();
  problem = probe.error ?? problem;
}
async function tick(): Promise<void> {
  if ((busy || document.hidden) && !running) return;
  // Never redraw under a hand typing in the address form, or in the reset
  // screen's confirmation box.
  if (isTextEntry(document.activeElement)) return;
  try {
    await refresh();
  } catch {
    return;
  }
  // Only while someone is looking at it. A tail pulled on every tick for a
  // collapsed disclosure is a CLI spawn per 1500 ms for a view nobody can
  // see — the cost with none of the benefit, which is the rule the console's
  // poll kept about its own hidden window.
  if (detailsOpen) {
    try {
      lastTail = await ipc.logs();
    } catch {
      /* the pane keeps its last content */
    }
  }
  render();
}

/**
 * A screen named from OUTSIDE this page: the SPA's danger and update cards,
 * through `desktop_open_assistant`, and the post-reset handoff.
 *
 * The payload is a member of a closed enum Rust parsed (`reset::Screen`), so
 * nothing here trusts a free string — `home` means "whatever the probe
 * implies", which is what a reset leaves behind and what the sidebar pill
 * asks for when it has no screen to name.
 */
/**
 * Apply a screen named from OUTSIDE this page, from either source.
 *
 * One function because there are two ways in and they must not drift: a LIVE
 * window is told by `reset::arm_and_raise`, and a window that is still coming
 * up ASKS on boot (`ipc.pendingScreen`). The asking is not a nicety — the
 * push it replaced was emitted from Rust's `on_page_load`, which fires before
 * this page's JavaScript exists.
 */
function applyScreen(payload: string): void {
  if (payload === "reset") {
    void openReset();
    return;
  }
  resetView.hide();
  // A pending selection belongs to one visit of the supervision screen, and
  // this is its other exit: the sidebar pill, an Update request or a Reset
  // request all land here while that screen may be showing.
  supervisionForm = null;
  // Same rule for the update act: its result and its fired-once latch belong
  // to ONE visit. Without this a window that finished an update and came back
  // would render "up to date" from a page fact rather than from the machine —
  // and, worse, a phase 2 that FAILED would come back to a screen with the
  // latch still set: no auto-fire, and no Try Again either, because the button
  // hangs off the result this would otherwise have kept.
  updateResult = null;
  resumeFired = false;
  // The ticks belong to one visit too: a selection made against the machine as
  // it was is not an answer about the machine as it is now.
  updateSelection = NO_SELECTION;
  // A REQUESTED permissions screen is not the handoff's, whatever this window
  // was doing a moment ago: it was asked for from somewhere the person can go
  // back to, so it takes Back rather than the Continue that opens a dashboard.
  permissionsAfterHandoff = false;
  screen = screenForRequest(payload);
  // A reset returns this page to a machine with nothing set up, so the
  // handoff guard has to be released or a later ready probe renders nothing.
  handedOff = false;
  replayEnter();
  render();
}

void listen<string>("desktop-screen", (event) => applyScreen(event.payload));
// The package manager's own output while tmux installs (`INSTALL_LINE_EVENT`
// in control.rs). Only the LAST line is kept: the screen shows what is
// happening now, and the full text still comes back in the ActionResult for
// the failure case. Rendered on arrival because the ordinary poll is stopped
// while an action runs.
void listen<string>("desktop-install-line", (event) => {
  const line = event.payload.trim();
  // Blank lines are spacing in the manager's output, not progress; showing
  // one would blank the only thing on screen that was saying anything.
  if (line === "" || installStartedAt === 0) return;
  installLine = line;
  render();
});
// The reset chain's progress: one frame per phase transition, merged into the
// reset view's page state. A chain that legitimately takes tens of seconds
// names the phase spending them instead of holding one word on a dead button
// (spec 2026-09-13 — the meter exists because slow-read-as-hung was reported).
void listen<{ step: string; state: string }>("desktop-reset-step", (event) =>
  resetView.applyStep(event.payload.step, event.payload.state),
);
// The app download's own progress. A ~100 MB bundle over a domestic link is
// tens of seconds of a dead button otherwise, which reads as a hang — the same
// report that put a meter on the reset chain.
//
// `total` is null where the release host sent no Content-Length, which is a
// real case: the line then counts megabytes rather than claiming a percentage
// it cannot compute.
void listen<{ received: number; total: number | null }>("desktop-app-update-progress", (event) => {
  const { received, total } = event.payload;
  const mb = (n: number) => (n / 1_000_000).toFixed(1);
  updateProgress =
    total === null ? `Downloading… ${mb(received)} MB` : `Downloading… ${mb(received)} of ${mb(total)} MB`;
  render();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
  const primary = el("bar-right").querySelector<HTMLButtonElement>("button.primary");
  if (primary && !primary.disabled) primary.click();
});

void (async () => {
  // PROBE FIRST, then the screen request, then the first render.
  //
  // `refresh()` sets `probe` and renders nothing, so nothing can slip between
  // the two and take the ready handoff — which is what this ordering has to
  // protect, and does.
  //
  // The screen request cannot come first, though it did until this comment
  // was written: `applyScreen("reset")` shows the reset screen SYNCHRONOUSLY,
  // and a reset screen drawn against `probe === null` renders `refusal(
  // undefined)` — "this server does not report its data locations… Reset
  // refuses to guess at a filesystem" — with its button disabled, for the
  // length of one CLI probe. A false and frightening sentence, on the one
  // screen where being trusted matters most.
  try {
    await refresh();
  } catch (err) {
    problem = errText(err);
  }
  // What this window was opened FOR. After the probe so the screen it raises
  // has facts to draw; before the first render so that render is already the
  // right screen rather than a flash of the wrong one.
  try {
    const requested = await ipc.pendingScreen();
    if (requested) applyScreen(requested);
  } catch {
    // An older Rust half knows no such command. Nothing was requested that
    // this page can honour, and the probe above already brought it up.
  }
  render();
  setInterval(() => void tick(), POLL_MS);
  // After the first render, never before: nothing on screen waits for it, and
  // a failed read must not stop the page from coming up on the machine it
  // exists to repair.
  try {
    about = await ipc.about();
    render();
  } catch {
    /* the disclosure omits the block */
  }
})();
