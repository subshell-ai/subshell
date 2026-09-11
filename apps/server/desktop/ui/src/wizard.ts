/**
 * The setup assistant (spec 2026-09-11 § 5): three screens in one fixed
 * frame, machine work as progress, the dashboard opened by the page itself.
 * DOM only; every judgment is imported from wizard-state and tested without
 * a webview. Shares lib/ with the console on purpose: prefill, the tmux plan
 * and the IPC edge are one contract, not two.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import type { ActionResult, Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import { canSetup, dots, failureLine, prereqState, type ScreenId, screensFor, setupRows } from "./lib/wizard-state";
import "./styles.css";

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the setup page is missing #${id}`);
  return node;
};
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const POLL_MS = 1500;

// ---------------------------------------------------------------------------
// State. The current screen is the one piece of page memory; everything else
// is a probe fact or an in-flight action.
// ---------------------------------------------------------------------------
let probe: Probe | null = null;
let screen: ScreenId = "welcome";
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
const form: FormValues = effectiveForm(undefined);
const explicit: ExplicitMap = {};
let seeded = false;

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------
/** Inline SVGs (lucide outlines, 24-grid). Fixed strings, this file's own; the ONLY innerHTML on the page. */
const ART = {
  icon: `<img src="./app-icon.png" alt="" />`,
  terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 17 6-6-6-6M12 19h8"/></svg>`,
  server: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/></svg>`,
  fail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
};
function setFrame(art: keyof typeof ART, title: string, subtitle: string): void {
  el("art").innerHTML = ART[art];
  el("title").textContent = title;
  el("subtitle").textContent = subtitle;
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
  if (probe === null) return;
  const { total, done, current } = dots(probe, screen);
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
const here = (): string => (probe?.platform === "darwin" ? "this Mac" : "this machine");

// ---------------------------------------------------------------------------
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
    const subject = here() === "this Mac" ? "This Mac" : "This machine";
    content.append(text("p", `${subject} has no package manager this app can drive. In a terminal:`, "hint"));
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
  if (running || p.next === "ready") {
    renderProgress(p);
    return;
  }
  if (failure) {
    renderFailure(p);
    return;
  }
  setFrame("server", "Set Up Your Server", `Here's what will happen on ${here()}.`);
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
  const list = screensFor(p);
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
  if (p.next === "ready") {
    if (openFailed) {
      setFrame("server", "Subshell Is Running", "The dashboard did not open by itself.");
      el("bar-left").append(button("Open Status Page", () => void ipc.openConsole().catch(setProblem), "ghost"));
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
    setFrame("server", "Setting Up Subshell…", "Opening your dashboard…");
    openWhenReady();
    return;
  }
  setFrame("server", "Setting Up Subshell…", "This takes a moment.");
  el("content").append(checklist(p, "active"));
}

function renderFailure(p: Probe): void {
  setFrame("fail", "Setup Couldn't Finish", "Nothing else was changed.");
  const content = el("content");
  content.append(checklist(p, "failed"));
  if (failure) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Show Details";
    const pre = document.createElement("pre");
    pre.className = "pane-pre output-bad";
    pre.textContent = [failure.stdout.trim(), failure.stderr.trim()].filter(Boolean).join("\n\n");
    details.append(summary, pre);
    content.append(details);
  }
  el("bar-left").append(button("Open Status Page", () => void ipc.openConsole().catch(setProblem), "ghost"));
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
  if (probe === null) return screen;
  const list = screensFor(probe);
  return list[Math.min(list.length - 1, list.indexOf(screen) + 1)] ?? screen;
}
function go(to: ScreenId): void {
  screen = to;
  const s = el("screen");
  s.classList.remove("enter");
  void s.offsetWidth; // restart the animation
  s.classList.add("enter");
  render();
}

async function act(fn: () => Promise<ActionResult | null>): Promise<void> {
  if (busy || running) return;
  busy = true;
  problem = "";
  render();
  try {
    const r = await fn();
    if (r && !r.ok) problem = failureLine(r);
  } catch (err) {
    problem = errText(err);
  }
  await refresh().catch(setProblem);
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
  renderDots();
  if (probe === null) {
    setFrame("icon", "Welcome to Subshell", "Checking this machine…");
    return;
  }
  // A machine that became ready while any screen was up goes to the dashboard;
  // the tmux screen advances the moment the fact lands.
  if (probe.next === "ready" || (screen === "tmux" && probe.tmux !== null)) screen = "setup";
  const p = probe;
  const views: Record<ScreenId, () => void> = {
    welcome: renderWelcome,
    tmux: () => renderTmux(p),
    setup: () => renderSetup(p),
  };
  views[screen]();
}

async function refresh(): Promise<void> {
  probe = await ipc.probe();
  problem = probe.error ?? problem;
}
async function tick(): Promise<void> {
  if ((busy || document.hidden) && !running) return;
  // Never redraw under a hand typing in the address form.
  if (document.activeElement instanceof HTMLInputElement) return;
  try {
    await refresh();
  } catch {
    return;
  }
  render();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
  const primary = el("bar-right").querySelector<HTMLButtonElement>("button.primary");
  if (primary && !primary.disabled) primary.click();
});

void (async () => {
  try {
    await refresh();
    if (probe) screen = screensFor(probe)[0] ?? "welcome";
  } catch (err) {
    problem = errText(err);
  }
  render();
  setInterval(() => void tick(), POLL_MS);
})();
