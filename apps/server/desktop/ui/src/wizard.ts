/**
 * The assistant (spec 2026-09-11 § 5; spec 2026-09-12 § 5.3): one fixed frame
 * and one screen at a time.
 *
 * It owns everything that has to render with the server DOWN — the first run
 * (Welcome, Install tmux, Set Up Your Server), the one Recovery screen a
 * machine sees once it has been set up and its server is not answering, the
 * Update screen, and Reset — and it is the only page granted the commands
 * that drive the CLI. `screensFor(probe, onboarded)` picks the family;
 * `update` and `reset` are entered by REQUEST, from the SPA's own cards over
 * `desktop_open_assistant` or from the recovery footer.
 *
 * DOM only. Every judgment is imported from `lib/wizard-state.ts` and
 * `lib/recovery-model.ts`, both pure and tested without a webview, and every
 * screen module lives under `assistant/` and takes an `AssistantHost` rather
 * than importing this file — a cycle back to the entry point is a temporal
 * dead zone at module evaluation, i.e. a blank window on the machine someone
 * is trying to repair.
 */
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyButton } from "./assistant/copy-button";
import { type AssistantHost, el, errText } from "./assistant/host";
import { renderOutput, renderTail } from "./assistant/logs";
import { createResetView } from "./assistant/reset-view";
import { buildTmuxWarning, type TmuxWarning } from "./assistant/tmux-warning";
import {
  CONFIG_FIELDS,
  configPayload,
  derivedBaseUrl,
  type ExplicitMap,
  effectiveForm,
  explicitFields,
  type FormValues,
  fieldProblems,
} from "./lib/config-form";
import { type ManualRoute, manualTmuxRoutes, tmuxInstallPlan } from "./lib/installers";
import type { About, ActionResult, LogTail, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import { paneRisk, recoveryFacts, recoverySubtitle } from "./lib/recovery-model";
import {
  applySupervisionChoice,
  autostartSupported,
  canSetup,
  DEFAULT_SUPERVISION,
  dots,
  failureLine,
  handoffView,
  isRequestedScreen,
  MIN_AUTOSTART_SERVER_VERSION,
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
 * The setup chain ran to completion in THIS window, so the ready screen owes
 * the person its result rather than vanishing into the dashboard. Page state
 * on purpose: `probe.onboarded` cannot answer it, since the probe sets that
 * flag on the very first `ready` it sees.
 */
let ranSetupHere = false;
/** They pressed Continue on that screen. */
let continued = false;
/**
 * Who made this app, its version and its terms — read ONCE and kept.
 *
 * Nine constants that cannot change while the app runs, so re-reading them
 * per render would be a CLI-free but still pointless round trip. A failed
 * read leaves this null and the disclosure simply omits the block.
 */
let about: About | null = null;
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
 * repeating the heading. The wordmark stays: Welcome is where the product
 * names itself, and it is the one screen whose art is doing work.
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
function renderDots(): void {
  const d = el("dots");
  d.textContent = "";
  if (probe === null || screen === null) return;
  const { total, done, current } = dots(probe, screen);
  // Recovery, Update and Reset are not steps on a journey, so there is no row
  // at all rather than a row of six empties. `dots` answers -1 for them.
  if (current < 0) return;
  const row = document.createElement("span");
  row.setAttribute("aria-hidden", "true");
  row.style.display = "contents";
  for (let i = 0; i < total; i += 1) {
    const dot = document.createElement("i");
    dot.className = i === current ? "current" : i < done ? "done" : "";
    row.append(dot);
  }
  d.append(row, text("span", `Step ${current + 1} of ${total}`, "sr-only"));
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
};

const resetView = createResetView(host);
/**
 * One warning for the one gated surface. The console needed a factory because
 * two sections rendered at once; here it is a factory for the other half of
 * the same reason — the element is re-appended by every render, and one
 * created per render would throw away a half-finished Copy.
 */
const tmuxWarn: TmuxWarning = buildTmuxWarning(host, () => void act(() => ipc.installTmux()));

// Screens. Each fills #content and the bar; ordering comes from screensFor.
// ---------------------------------------------------------------------------
function renderWelcome(): void {
  setFrame(
    "icon",
    "Welcome to Subshell",
    `Subshell runs agent sessions in terminal panes you can watch from any device. Let's set up the server on ${here()}.`,
  );
  el("bar-right").append(button("Continue", () => go(next()), "primary"));
}

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
  head.append(spinner, text("span", "Installing tmux…", "label"), text("span", elapsed(installStartedAt), "detail"));
  box.append(head);
  const line = text("p", installLine || "Starting the package manager…", "install-line");
  line.setAttribute("aria-live", "polite");
  box.append(line);
  return box;
}

function renderTmux(p: Probe): void {
  const found = prereqState(p) === "found";
  // ONE title in both states. It was "tmux Is Ready" when tmux was already
  // there, which answered a question nobody asked and raised the one they
  // did — a panel announcing something is ready reads as a result, leaving
  // "so why am I being shown this?". The title names the STEP, which is the
  // same step on every machine; whether there is anything to do is what the
  // content below says.
  setFrame("none", "Install tmux", "Every subshell runs in a tmux pane, so the server needs it before it can start.");
  const content = el("content");
  const plan = tmuxInstallPlan(p.platform, p.hasBrew);
  const installing = busy && prereqState(p) === "install" && plan.kind === "run";
  // The screen a machine that ALREADY has tmux now sees. It used to be
  // skipped outright, which satisfied the dependency invisibly and left a
  // gap in the dots; saying so costs one Continue and is the only place the
  // person is told what tmux is for.
  if (found) {
    // The checklist's own done-mark, so "installed" looks the same wherever
    // this app says it. No path: which file answered is a fact for Settings,
    // not an answer to "do I need to do anything here" — and a monospace
    // path was the widest thing on a screen whose message is one word.
    const row = document.createElement("p");
    row.className = "tmux-ready";
    row.append(text("span", "✓", "glyph"), text("span", "Already installed on this machine", "label"));
    content.append(row);
  } else if (prereqState(p) === "install" && plan.kind === "run") {
    if (busy) {
      content.append(installProgress());
    } else {
      content.append(
        button(
          plan.label,
          () =>
            void act(() => {
              installLine = "";
              installStartedAt = Date.now();
              startInstallClock();
              return ipc.installTmux();
            }),
          "primary big",
        ),
      );
      // Centred under a full-width button: left-aligned, it read as a caption
      // for the screen's left edge rather than for the button it belongs to.
      content.append(text("p", "Your package manager may ask for your password.", "hint centered"));
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
  el("bar-left").append(button("Back", () => go("welcome"), "ghost", installing));
  // NO reason text beside Continue. This screen carries a hardcoded "Waiting
  // for tmux", which read the same during the install it had itself started —
  // a sentence about the PERSON at the one moment the app was the one
  // working. Making it say "Installing…" instead only moved the problem: the
  // pane above already says that, with a spinner, a clock and the package
  // manager's own words. A disabled button next to a label repeating the
  // screen is the screen saying it twice.
  el("bar-right").append(button("Continue", () => found && go(next()), "primary", !found));
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
    copyButton(() => route.command, { label: `the ${route.name} command` }),
  );
  panel.append(line);
  return panel;
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
  setFrame("none", SETUP_TITLE, `Choose how the server runs on ${here()}.`);
  const content = el("content");
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
  const gate = canSetup(p, busy);
  const list = screensFor(p, false);
  const prev = list[Math.max(0, list.indexOf("setup") - 1)] ?? "welcome";
  el("bar-left").append(button("Back", () => go(prev), "ghost"));
  if (!gate.ok && gate.reason) el("bar-right").append(text("span", gate.reason, "reason"));
  el("bar-right").append(button("Set Up", () => void startSetup(), "primary", !gate.ok));
}

/**
 * The supervision question — the whole content of the Set Up screen.
 *
 * **It used to sit under a plan**: two rows promising "Install the server →
 * ~/.local/bin/subshell-server" and "Open your dashboard → http://…". Both
 * are gone, and nothing replaced them, because they were already said twice.
 * `setupRows` feeds the progress checklist on the VERY NEXT screen, which
 * names each act with the same detail as it happens; Settings → Service holds
 * the same facts permanently afterwards. Promising them beforehand made a
 * screen whose one real question — who runs this server — read as a footnote
 * under a list of things the reader could not act on.
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
 * The last screen either family sees: the server answers, so the dashboard is
 * what comes next and this window has nothing left to say.
 *
 * The title differs because the sentence does. A first run is finishing; an
 * onboarded machine whose server just came back was never setting anything
 * up, and telling it so would be the app narrating its own state machine.
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
  // "what did that just do", and on a machine that already had everything it
  // is the only chance to read it.
  el("content").append(checklist(p, "active"));
  el("bar-right").append(
    button(
      "Continue",
      () => {
        continued = true;
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
  }
  // Reachable HERE as well as from the dashboard, and that is the point: a
  // machine whose service definition is broken has no dashboard to open the
  // door from, and switching to app mode is one of the few things that can
  // get such a machine running again.
  content.append(button("Change how it runs…", () => go("supervision"), "linkish"));
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

  // What this APP is, which no other surface can answer on a machine whose
  // server is down: the SPA's About dialog needs the SPA, and the SPA needs
  // the server this screen exists because of. Every string is Rust's copy of
  // the shared legal constants, so the page stores none of them.
  if (about !== null) {
    const facts = document.createElement("dl");
    facts.className = "facts";
    for (const [label, value] of [
      ["This app", `${about.appName} ${about.appVersion}`],
      ["Terms", about.licenseSummary],
      ["Copyright", about.copyright],
    ]) {
      const dt = document.createElement("dt");
      dt.textContent = label as string;
      const dd = document.createElement("dd");
      dd.append(text("span", value as string, ""));
      facts.append(dt, dd);
    }
    details.append(text("p", "About", "group-heading"), facts);
    const links = document.createElement("p");
    links.className = "about-links";
    // A member of a CLOSED enum, never a URL: the same addresses travel here
    // for display, and showing an address is a different capability from
    // navigating to one.
    for (const [label, target] of [
      ["Website", "website"],
      ["Licence", "license"],
      ["Publisher", "company"],
    ] as const) {
      links.append(button(label, () => void ipc.openWeb(target).catch(setProblem), "linkish"));
    }
    details.append(links);
  }
  return details;
}

/**
 * Update Your Server: the bundled copy is newer than the installed one.
 *
 * Reached from the SPA's Update card (`desktop_open_assistant({ screen:
 * "update" })`) or from the recovery screen, and it renders over a RUNNING
 * server — which is why `render()` lets a requested screen outrank the ready
 * handoff, or this window would bounce straight back to the dashboard it was
 * just asked to leave.
 */
function renderUpdate(p: Probe): void {
  setFrame(
    "none",
    "Update Your Server",
    `Subshell Server includes ${p.bundledVersion ?? "no server"}; ${here()} is running ${p.server?.version ?? "an unknown version"}.`,
  );
  const content = el("content");
  if (paneRisk(p)) {
    content.append(
      text(
        "p",
        "The installed service definition does not spare live panes, so this restart closes every subshell running here.",
        "hint warn-text",
      ),
    );
  }
  content.append(
    button(
      "Update and Restart",
      () =>
        void act(async () => {
          const installed = await ipc.installServer();
          if (!installed.ok) return installed;
          // `--force` only where the definition would refuse over live panes;
          // the CLI rejects the flag on every other verb.
          return ipc.service("restart", paneRisk(p));
        }, true),
      "primary big",
    ),
  );
  el("bar-left").append(button("Not Now", () => host.close(), "ghost"));
}

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
  const rows = setupRows(p, { port: form.port, host: form.host }, supervision);
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
      if (field.name === "port" && explicit.baseUrl !== true) {
        form.baseUrl = derivedBaseUrl(input.value);
        const mirror = document.getElementById("field-baseUrl") as HTMLInputElement | null;
        if (mirror) mirror.value = form.baseUrl;
      }
      // Nothing outside the form mirrors the port any more: the row that read
      // "Open your dashboard → http://…" is gone, and the baseUrl field above
      // is updated in place. Re-rendering here would only interrupt typing.
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
function next(): ScreenId {
  if (probe === null || screen === null) return screen ?? "welcome";
  // The first-run family: this is the Continue button's forward step, and
  // only the first run has one — recovery is a single screen and the two
  // requested screens are entered by name.
  const list = screensFor(probe, false);
  return list[Math.min(list.length - 1, list.indexOf(screen) + 1)] ?? screen;
}
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
    // person still pressed Set Up and still deserves to be shown where it got
    // to, rather than the window deciding on their behalf.
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
    renderDots();
    setFrame("icon", "Welcome to Subshell", "Checking this machine…");
    return;
  }
  const p = probe;
  // A REQUESTED screen outranks the probe's own family — BOTH of them, which
  // is the rule `isRequestedScreen` states beside the `screensFor` that
  // explains why neither is ever in a probe's list. The SPA deep-links here on
  // a machine whose server is running (Update from its card, Reset from its
  // danger card), and the ready handoff below would otherwise send the window
  // straight back to the dashboard it was just asked to leave.
  //
  // `update` draws itself here. `reset` does not: its screen replaces the
  // frame from `resetView` at the top of this function. Since `open()` shows
  // BEFORE it arms, `isOpen()` is true from the moment the request is applied
  // and that check catches reset first — so this arm is defence in depth for
  // that screen rather than its only guard, and it stays because the rule is
  // "a requested screen outranks the probe's family", which should not have
  // to be re-derived if `open()` ever awaits again.
  if (isRequestedScreen(screen)) {
    renderDots();
    if (screen === "update") renderUpdate(p);
    if (screen === "supervision") renderSupervision(p);
    return;
  }
  const list = screensFor(p, p.onboarded);
  if (list.length === 0) {
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
    renderDots();
    renderHandoff(p);
    return;
  }
  handedOff = false;
  // NO auto-advance off the tmux screen. It used to jump to `setup` the
  // moment `p.tmux` was non-null, which was a SECOND skip independent of
  // `screensFor` — so the step stayed invisible on a machine that already had
  // tmux even after the list stopped filtering it, and Back from `setup` was
  // dead: `go("tmux")` set the screen and the next render bounced it straight
  // back. The screen has a real installed state now (a done-mark and an
  // enabled Continue), which is also the confirmation a two-minute install
  // deserves rather than the screen vanishing out from under it.
  // Resolve `null`, and correct a screen the probe no longer offers: a
  // machine that finishes its first run becomes onboarded, and "setup" is not
  // on the recovery family's list.
  if (screen === null || !list.includes(screen)) screen = list[0] ?? "welcome";
  renderDots();
  const views: Record<"welcome" | "tmux" | "setup" | "recovery", () => void> = {
    welcome: renderWelcome,
    tmux: () => renderTmux(p),
    setup: () => renderSetup(p),
    recovery: () => renderRecovery(p),
  };
  // `screen` is one of the four by construction — `list` only ever holds
  // those — and the fallback exists so a family added later is a Welcome
  // screen rather than a blank window on a machine someone is repairing.
  (views[screen as "welcome" | "tmux" | "setup" | "recovery"] ?? renderWelcome)();
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
