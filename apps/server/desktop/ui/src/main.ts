/**
 * The server console — the one surface that must render with the server DOWN,
 * and the only one allowed to drive the `subshell-server` CLI.
 *
 * TypeScript on Vite with Tailwind (2026-09-10). The page stayed plain JS for
 * as long as its argument was "no build step between the user and the thing
 * that fixes their broken install"; the build moved INSIDE that promise rather
 * than in front of it — `tauri dev` and `tauri build` run `vite build` as
 * their own before-hook, so there is no way to launch or bundle the app that
 * skips it, and the CSP-clean output rules (inline preload polyfill off, no
 * inlined assets) live in `vite.config.ts` against the policy in
 * `tauri.conf.json`. It is still a module rather than an inline script
 * because `script-src 'self'` applies, and the pure decisions still live in
 * `lib/` where they can be tested without a webview.
 *
 * This file is the ENTRY and the chrome (spec 2026-09-11 § 9): the shared
 * state, `render()`, `guard()`, the poll, and the sidebar. Each section's DOM
 * lives in its own module under `console/`, and none of them imports this one —
 * they receive a `ConsoleHost` instead. A cycle back to the entry point is a
 * temporal dead zone at module evaluation, which on this page means a blank
 * window on a machine someone is trying to repair.
 */
import { createAbout } from "./console/about";
import { renderFacts } from "./console/facts";
import { renderHero } from "./console/hero";
import { refreshLog, show, showPane, syncPaneTabs, wirePaneTabs } from "./console/logs";
import { createResetView } from "./console/reset-view";
import { renderResultStrip } from "./console/result-strip";
import { type ConsoleHost, el, errText, SETTLE_ATTEMPTS, SETTLE_DELAY_MS, sleep, slots, state } from "./console/state";
import { createSteps } from "./console/steps";
import { heroState, NAV_TREE, navGroupOpen, SECTION_LABELS, SECTIONS, type SectionId } from "./lib/console-nav";
import type { ActionResult } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import "./styles.css";

// ---------------------------------------------------------------------------
// The chrome: the sidebar, the page-wide message slots
// ---------------------------------------------------------------------------

/** The nav buttons, built once from NAV_TREE so the label map is the one source. */
const navButtons = new Map<SectionId, HTMLButtonElement>();

/** The group header and the container it discloses, or null before `buildNav`. */
let navGroup: { header: HTMLButtonElement; children: HTMLElement; sections: readonly SectionId[] } | null = null;

/**
 * A chevron press, outstanding until the section changes — `undefined` means
 * the group simply follows the current section (`navGroupOpen`). `goTo` clears
 * it, which is what makes the press expire rather than accumulate.
 *
 * Deliberately not persisted, and deliberately not on `state`: it is meant to
 * last until you go somewhere else, and no section module has any business
 * reading it — the sidebar is this file's.
 */
let navGroupPress: boolean | undefined;

/** One section's button. Shared by the top-level rows and a group's children. */
function buildNavItem(id: SectionId, child: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = child ? "nav-item child" : "nav-item";
  // Every item is reachable, always. A section that cannot help says so in
  // its own words — a dimmed item with a tooltip would put the reason
  // somewhere a keyboard or a touch never goes.
  const dot = document.createElement("span");
  dot.className = "nav-dot";
  // Only Overview carries one: it mirrors the hero's state colour, so the
  // machine's state is readable from every section without switching back.
  dot.hidden = id !== "overview";
  const label = document.createElement("span");
  label.textContent = SECTION_LABELS[id];
  b.append(dot, label);
  b.addEventListener("click", () => goTo(id));
  navButtons.set(id, b);
  return b;
}

function buildNav(): void {
  const nav = el("nav");
  for (const entry of NAV_TREE) {
    if (entry.kind === "section") {
      nav.append(buildNavItem(entry.id, false));
      continue;
    }
    // A group is a label and a chevron, never a page: it toggles its children
    // and navigates nowhere, which is what lets the header be one control
    // instead of a link with a second button beside it.
    const header = document.createElement("button");
    header.type = "button";
    header.className = "nav-group";
    const listId = `nav-group-${entry.id.replace(/-group$/, "")}`;
    header.setAttribute("aria-controls", listId);
    const label = document.createElement("span");
    label.textContent = entry.label;
    const chevron = document.createElement("span");
    chevron.className = "nav-chevron";
    chevron.setAttribute("aria-hidden", "true");
    header.append(label, chevron);
    header.addEventListener("click", () => {
      // Flips what the header is CURRENTLY showing, so the first press always
      // visibly does something. Toggling a stored flag instead is how a press
      // becomes a no-op whenever that flag and the current section disagree.
      navGroupPress = !navGroupOpen(navGroupPress, entry.children.includes(state.section));
      renderNav();
    });
    const children = document.createElement("div");
    children.className = "nav-group-children";
    children.id = listId;
    for (const id of entry.children) children.append(buildNavItem(id, true));
    nav.append(header, children);
    navGroup = { header, children, sections: entry.children };
  }
}

function renderNav(): void {
  const { tone } = heroState(state.probe, state.busy);
  for (const [id, b] of navButtons) {
    const current = state.section === id;
    b.classList.toggle("current", current);
    if (current) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
    const dot = b.querySelector<HTMLElement>(".nav-dot");
    if (dot && id === "overview") {
      dot.className = `nav-dot bg-${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "muted"}`;
    }
  }
  if (navGroup !== null) {
    const holdsCurrent = navGroup.sections.includes(state.section);
    const open = navGroupOpen(navGroupPress, holdsCurrent);
    navGroup.header.setAttribute("aria-expanded", String(open));
    navGroup.children.hidden = !open;
    // Shut over the current section, the header is the only row left that can
    // say where you are — everything with a `current` class is inside the
    // container above. Without this the sidebar highlights nothing at all.
    navGroup.header.classList.toggle("holds-current", holdsCurrent && !open);
  }
  // The version, in the sidebar's foot. Before the first probe it says
  // nothing rather than guessing, and a machine with no server says so — the
  // hero says it too, but the foot is visible from every section.
  el("sidebar-version").textContent =
    state.probe === null ? "" : (state.probe.server?.version ?? (state.probe.server ? "unknown version" : "no server"));
}

/**
 * The problem line, written into every section that can produce one.
 *
 * It is page state rather than a section's, because the action that set it may
 * have been pressed anywhere: a rejection raised on one section and rendered
 * only on another is a refusal nobody reads. Sections carry a `data-problem`
 * slot; Logs has no actions and therefore none.
 */
function renderProblem(): void {
  for (const box of slots("data-problem")) box.textContent = state.problem;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function goTo(section: SectionId): void {
  if (section === state.section) return;
  state.section = section;
  // A chevron press lasts until you go somewhere else: clearing it here is
  // what lets the group fall back to following the section, so leaving the
  // group shuts it and entering one opens it.
  navGroupPress = undefined;
  // About reads nine constants once and keeps them: they cannot change while
  // the app runs, so re-reading on every visit would be a CLI-free but still
  // pointless round trip. A FAILED read leaves itself unloaded and retries.
  if (section === "about") void about.load();
  render();
}

function render(): void {
  renderNav();
  renderProblem();
  renderResultStrip(host);
  for (const id of SECTIONS) el(`section-${id}`).hidden = id !== state.section;

  // Only the CURRENT section renders. Two sections holding a tmux warning each
  // is the reason that element is a factory rather than a singleton; nothing
  // else here would notice, but rendering the hidden ones would be work done
  // on every five-second tick for a view nobody can see.
  if (state.section === "overview") {
    renderHero();
    steps.render();
    renderFacts(host);
  } else if (state.section === "about") {
    about.render();
  }
  // The reset view coexists with the busy state; its buttons re-arm themselves
  // from the probe, so every re-render keeps the screen honest about it.
  if (resetView.isOpen()) resetView.render();
}

async function refresh(): Promise<void> {
  state.probe = await ipc.probe();
  // The Rust side reports the CLI's own failure text rather than letting a
  // failed `status` masquerade as an unconfigured server.
  state.problem = state.probe.error ?? "";
}

/**
 * Wrap an action so two cannot run at once, the UI always re-renders, and a
 * rejection is surfaced instead of leaving every button disabled forever.
 *
 * `settle` asks for the extra re-probes: pass it when the action's WHOLE
 * POINT is a running server (install, start, restart), so the console lands
 * on `ready` rather than mid-transition. Stop and uninstall never pass it —
 * waiting for a `ready` that must not arrive is polling with extra steps.
 *
 * The `label` is the button's own, and it is what the result strip says
 * afterwards. Before the sidebar the outcome was read off the output pane
 * directly under the buttons; that pane is a section away now, so the press
 * needs a line where it happened.
 */
function guard(label: string, fn: () => Promise<ActionResult | null>, settle = false): () => Promise<void> {
  return async () => {
    if (state.busy) return;
    state.busy = true;
    state.problem = "";
    state.lastResult = null;
    show(null);
    render();
    // The action's own failure line is applied AFTER the re-probe, not inside
    // the try: `refresh` rewrites `problem` from `probe.error`, and setting it
    // here meant an `ok:false` result erased its own message before the render
    // that was supposed to show it (measured pre-migration too; the red output
    // pane is why nobody noticed). The press the user just made outranks the
    // background state — the CLI's own words are in the pane either way.
    let failure: string | null = null;
    let outcome: { ok: boolean; hasOutput: boolean } | null = null;
    try {
      const result = await fn();
      // `show` returns whether the command said anything, which is what
      // decides if the strip's "Show output" leads anywhere.
      const spoke = result ? show(result) : false;
      if (result) outcome = { ok: result.ok, hasOutput: spoke };
    } catch (err) {
      // A command that rejects (or a Rust `Err`) must not strand the console.
      failure = errText(err);
    }
    try {
      await refresh();
      for (let i = 0; settle && i < SETTLE_ATTEMPTS && state.probe?.next !== "ready"; i += 1) {
        await sleep(SETTLE_DELAY_MS);
        await refresh();
      }
    } catch (err) {
      state.problem = state.problem || `Could not read this machine's state: ${errText(err)}`;
    }
    if (failure !== null) state.problem = failure;
    state.lastResult = outcome === null ? null : { label, ...outcome };
    state.busy = false;
    render();
  };
}

const host: ConsoleHost = {
  render,
  refresh,
  guard,
  goTo,
  fail(err: unknown) {
    state.problem = errText(err);
    render();
  },
};

buildNav();
wirePaneTabs();
const steps = createSteps(host);
const about = createAbout(host);
const resetView = createResetView(host);

el("reset-open").addEventListener("click", () => {
  void resetView.open();
});

/**
 * How often the console re-reads the machine on its own.
 *
 * The manager's whole subject is state this app does not own — a service that
 * can be started, stopped or crash from anywhere — so a console that only
 * refreshes when asked shows a stale answer and puts the burden of noticing on
 * the user. It also drives the TRAY's enabled state (`desktop_probe` is the
 * one place that updates), so without this a server started elsewhere leaves
 * the tray disabled until someone opens this window and clicks.
 *
 * This is the poll that `SETTLE_ATTEMPTS` deliberately is NOT, so it pays the
 * same cost honestly: each tick is a few short CLI spawns. What makes it
 * affordable is that the expensive parts happen ONCE per process, not per
 * probe — the login-shell PATH probe and the bundled binary's version are both
 * memoized behind a `OnceLock` in the Rust half. Five seconds is chosen to be
 * faster than a person reaches for the button and slower than the manager
 * changes its mind.
 */
const POLL_MS = 5000;

/**
 * A background re-probe. Skipped in two cases, both of which would make it
 * harmful rather than merely wasteful:
 *
 * - **`busy`** — an action owns the state, ends in its own re-probe, and may
 *   be mid-SETTLE. A poll landing in the middle would race that and could
 *   render a transition as the final answer.
 * - **hidden** — a window closed to the tray is watched by nobody, and paying
 *   CLI spawns forever for a view no one can see is the cost with none of the
 *   benefit. Best-effort: platforms differ on whether a hidden native window
 *   reports `document.hidden`, so this is a saving, not a guarantee.
 *
 * A failed poll is swallowed on purpose. `refresh` already records the CLI's
 * own words in `problem`, and a transient failure nobody asked about must not
 * become an unhandled rejection.
 */
async function poll(): Promise<void> {
  if (state.busy || document.hidden) return;
  try {
    await refresh();
  } catch {
    return;
  }
  render();
  // Separate try: a log tail that cannot be read must not stop the probe's
  // result from being rendered. It runs whatever section is on screen, so the
  // Logs pane is current the moment it is opened rather than a tick later.
  try {
    await refreshLog();
  } catch {
    /* the pane keeps its last content */
  }
}

setInterval(() => void poll(), POLL_MS);
// A window being shown again should not wait out the rest of the interval —
// that is exactly when its contents are most likely to be stale.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void poll();
});

showPane("log");
// At boot no command has run, so the output tab is not offered yet.
syncPaneTabs();
render();
void steps.retry();
void refreshLog().catch(() => {});
