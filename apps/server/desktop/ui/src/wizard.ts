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
import { tmuxInstallPlan } from "./lib/installers";
import type { About, ActionResult, LogTail, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import { paneRisk, recoveryFacts, recoverySubtitle } from "./lib/recovery-model";
import {
  canSetup,
  dots,
  failureLine,
  isRequestedScreen,
  prereqState,
  RESET_LABEL,
  type RecoveryActionKind,
  recoveryAction,
  recoveryTitle,
  type ScreenId,
  SETUP_TITLE,
  screensFor,
  setupRows,
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
let seeded = false;

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------
/**
 * Inline SVGs (lucide outlines, 24-grid) plus the product wordmark. Fixed
 * strings, this file's own; the ONLY innerHTML on the page.
 *
 * `icon` is the FULL wordmark, not the `/s` mark: the Welcome screen is where
 * the product names itself, and the mark alone says nothing to someone opening
 * this app for the first time. Both PNGs are generated into `ui/public` by
 * `bun run brand:generate` — this page is its own Vite build and cannot reach
 * the SPA's `public/icons`.
 */
const ART = {
  icon: `<img src="./wordmark-96.png" srcset="./wordmark-96.png 1x, ./wordmark-192.png 2x" alt="" />`,
  terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 17 6-6-6-6M12 19h8"/></svg>`,
  server: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/></svg>`,
  fail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
};
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

function renderTmux(p: Probe): void {
  setFrame(
    "terminal",
    "Install tmux",
    "Every subshell runs in a tmux pane, so the server needs it before it can start.",
  );
  const content = el("content");
  const plan = tmuxInstallPlan(p.platform, p.hasBrew);
  if (prereqState(p) === "install" && plan.kind === "run") {
    if (busy) {
      content.append(text("p", "Installing tmux…", "assistant-subtitle"));
    } else {
      content.append(button(plan.label, () => void act(() => ipc.installTmux()), "primary big"));
      content.append(text("p", "Your package manager may ask for your password.", "hint"));
    }
  } else {
    content.append(text("p", "This machine has no package manager this app can drive. In a terminal:", "hint"));
    if (plan.command.length > 0) content.append(text("span", plan.command.join(" "), "code-line"));
    if (plan.docsUrl !== "")
      content.append(button("Read the tmux docs", () => void ipc.openTmuxDocs().catch(setProblem), "ghost"));
  }
  el("bar-left").append(button("Back", () => go("welcome"), "ghost"));
  el("bar-right").append(
    text("span", "Waiting for tmux", "reason"),
    button("Continue", () => {}, "primary", true),
  );
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
  setFrame("server", SETUP_TITLE, `Here's what will happen on ${here()}.`);
  const content = el("content");
  content.append(planRows(p));
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
      "linkish",
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

/** The three what-will-happen rows. Re-rendered by the address form's input handler, never the inputs. */
function planRows(p: Probe): HTMLUListElement {
  const rows = setupRows(p, { port: form.port, host: form.host });
  const base = form.baseUrl || derivedBaseUrl(form.port || "3080");
  const ul = document.createElement("ul");
  ul.className = "plan-rows";
  ul.id = "plan-rows";
  for (const [label, detail] of [
    ["Install the server", rows.find((r) => r.id === "server")?.detail ?? ""],
    ["Start it in the background, and at every login", ""],
    ["Open your dashboard", base],
  ]) {
    const li = document.createElement("li");
    li.append(document.createElement("span"), text("span", label, "label"), text("span", detail, "detail"));
    ul.append(li);
  }
  return ul;
}

function renderProgress(p: Probe): void {
  setFrame("server", "Setting Up Subshell…", "This takes a moment.");
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
    setFrame("server", "Subshell Is Running", "The dashboard did not open by itself.");
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
  setFrame("server", p.onboarded ? "Your Server Is Running" : "Setting Up Subshell…", "Opening your dashboard…");
  openWhenReady();
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
  setFrame("server", recoveryTitle(p.next), recoverySubtitle(p.next));
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
    "server",
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

/** Arm a plan and raise the Reset screen. */
async function openReset(): Promise<void> {
  screen = "reset";
  // `open()` shows the screen whether or not a plan staged: the screen is
  // what explains a refusal.
  await resetView.open();
}

function renderFailure(p: Probe): void {
  setFrame("fail", "Setup Couldn't Finish", "Nothing else was changed.");
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
  const rows = setupRows(p, { port: form.port, host: form.host });
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
      // The plan rows follow the form; the inputs are left alone so typing is never interrupted.
      document.getElementById("plan-rows")?.replaceWith(planRows(p));
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
  render();
}

async function startSetup(): Promise<void> {
  if (busy || running || probe === null) return;
  running = true;
  failure = null;
  problem = "";
  render();
  let result: ActionResult | null = null;
  try {
    result = await ipc.setup(configPayload(form, explicit));
  } catch (err) {
    problem = errText(err);
  } finally {
    running = false;
  }
  if (result && !result.ok) failure = result;
  await refresh().catch(() => {});
  if (result?.ok) {
    // `service start` returns when the manager has spawned the process, not
    // when the port is bound: two more looks before deciding.
    for (let i = 0; i < 2 && probe?.next !== "ready"; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      await refresh().catch(() => {});
    }
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
  // frame from `resetView` at the top of this function, and it raises itself
  // ASYNCHRONOUSLY — so between the request and `open()` flipping `isOpen()`,
  // returning here is the only thing standing between this window and the
  // handoff.
  if (isRequestedScreen(screen)) {
    renderDots();
    if (screen === "update") renderUpdate(p);
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
  // The tmux screen advances itself the moment the fact lands — the second
  // automatic advance, and the reason `replayEnter` is called here too.
  if (screen === "tmux" && p.tmux !== null) {
    screen = "setup";
    replayEnter();
  }
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
  if (document.activeElement instanceof HTMLInputElement) return;
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
  screen = payload === "update" ? "update" : null;
  // A reset returns this page to a machine with nothing set up, so the
  // handoff guard has to be released or a later ready probe renders nothing.
  handedOff = false;
  replayEnter();
  render();
}

void listen<string>("desktop-screen", (event) => applyScreen(event.payload));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
  const primary = el("bar-right").querySelector<HTMLButtonElement>("button.primary");
  if (primary && !primary.disabled) primary.click();
});

void (async () => {
  // BEFORE the probe, and before the first render: this answers what the
  // window was opened FOR, and a render that ran without it would take the
  // ready handoff — open the dashboard, close this window — on exactly the
  // machines a requested screen is asked for from. `openReset` raises its
  // screen synchronously, so one call here is enough to hold the window.
  try {
    const requested = await ipc.pendingScreen();
    if (requested) applyScreen(requested);
  } catch {
    // An older Rust half knows no such command. Nothing was requested that
    // this page can honour, and the probe below still brings it up.
  }
  try {
    await refresh();
  } catch (err) {
    problem = errText(err);
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
