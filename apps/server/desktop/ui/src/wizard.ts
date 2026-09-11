/**
 * The first-run wizard (spec § 5 of the 2026-09-10 design): decisions are
 * steps, machine work is progress. DOM only; every judgment is imported from
 * wizard-state, where it is tested without a webview. Shares lib/ with the
 * console on purpose: prefill, install plans and the IPC edge are one
 * contract, not two.
 *
 * The console rules that carry over verbatim: no Refresh button (the poll
 * below is the refresh), the CLI's words render unedited, and no control is
 * disabled without its reason named beside it. The rule that does not carry
 * over: nothing here is a facts panel. One step at a time, and the rail says
 * where the human is.
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
import { agentInstallPlan, tmuxInstallPlan } from "./lib/installers";
import type { Probe } from "./lib/ipc";
import * as ipc from "./lib/ipc";
import {
  canContinue,
  firstOpenStep,
  prereqState,
  runRows,
  STEP_LABELS,
  STEP_ORDER,
  type WizardStepId,
} from "./lib/wizard-state";
import "./styles.css";

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the wizard page is missing #${id}`);
  return node;
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

let probe: Probe | null = null;
let busy = false;
let problem = "";
let step: WizardStepId = "welcome";
/** True only while the chain runs: the poll must not stop for that (below). */
let running = false;
/** The Addresses step's values, held outside the DOM for the console's own
 *  reason: the form is rebuilt on step changes and a re-probe must not eat
 *  what someone typed. */
const form: FormValues = effectiveForm(undefined);
const explicit: ExplicitMap = {};
/** Agents rows remember what THIS session installed; the probe cannot see
 *  agent CLIs, and pretending otherwise would redraw them as missing on
 *  every poll. */
const agentInstalled = new Set<string>();

const AGENTS: { id: string; name: string; blurb: string }[] = [
  { id: "claude-code", name: "Claude Code", blurb: "Anthropic's agent CLI." },
  { id: "codex", name: "Codex", blurb: "OpenAI's agent CLI." },
  { id: "hermes", name: "Hermes", blurb: "Nous Research's agent CLI." },
  { id: "opencode", name: "OpenCode", blurb: "Open-source agent CLI, multiple providers." },
  { id: "pi", name: "Pi", blurb: "Minimal agent CLI." },
];

/**
 * How often the wizard re-reads the machine. One interval, one speed, for
 * two reasons the console also knows: it is faster than a person reaches
 * for a button and slower than the manager changes its mind, and a
 * reschedulable timer would be a second mechanism for no gain. During a Run
 * this SAME poll is the checklist's updater (see `tick`), which is why the
 * skip conditions leave `running` unskippable.
 */
const POLL_MS = 1500;

function button(label: string, handler: () => unknown, primary = false, disabled = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (primary) b.className = "primary";
  b.disabled = disabled || busy;
  b.addEventListener("click", handler);
  return b;
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "wizard-copy";
  p.textContent = text;
  return p;
}

function bulletList(items: string[]): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.className = "wizard-copy list-disc pl-5";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.append(li);
  }
  return ul;
}

function showOutput(result: ipc.ActionResult | null): void {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  el("output").textContent = parts.join("\n\n");
  (el("output") as HTMLElement).classList.toggle("output-bad", result?.ok === false);
  el("output-card").hidden = parts.length === 0;
}

const stepIndex = (id: WizardStepId): number => STEP_ORDER.indexOf(id);

function go(next: WizardStepId): void {
  step = next;
  render();
}

/**
 * Run one act: single-flight, always re-render, and a rejection surfaces
 * instead of leaving every button dead (the console's `guard`, kept small
 * because the wizard has one action shape, not the console's six).
 */
async function runGuarded(fn: () => Promise<ipc.ActionResult | null>, settle = false): Promise<void> {
  if (busy) return;
  busy = true;
  problem = "";
  showOutput(null);
  render();
  try {
    const result = await fn();
    if (result) showOutput(result);
  } catch (err) {
    problem = errText(err);
  }
  await refresh().catch((err: unknown) => {
    problem = errText(err);
  });
  if (settle) {
    // Same budget and same reason as the console's SETTLE_ATTEMPTS: one
    // re-probe can land mid-transition, and Done must not be withheld by a
    // race the next tick resolves on its own.
    for (let i = 0; i < 2 && probe?.next !== "ready"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refresh().catch(() => {});
    }
  }
  busy = false;
  render();
}

async function refresh(): Promise<void> {
  probe = await ipc.probe();
  problem = probe.error ?? "";
}

// ---------------------------------------------------------------------------
// The screens. Each renders into #screen / #screen-actions and nothing else;
// ordering and gating come from wizard-state, never from local arithmetic.
// ---------------------------------------------------------------------------

function renderWelcome(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(
    paragraph(
      "Subshell runs agent sessions in terminal panes you can watch from any device. This sets up a control plane on this machine: the server, its settings, and a background service that keeps them running.",
    ),
    paragraph("Get started consents to all of this:"),
    bulletList([
      "Installs the bundled subshell-server to ~/.local/bin/subshell-server. Nothing is downloaded.",
      "Writes ~/.config/subshell-server/config.env (port 3080, all interfaces, unless you change them).",
      "Registers it to start at login (a systemd user unit on Linux, a launchd agent on macOS).",
      "Starts it and opens the dashboard.",
    ]),
  );
  actions.append(button("Get started", () => go("prerequisites"), true));
}

function renderPrerequisites(screen: HTMLElement, actions: HTMLElement): void {
  if (probe === null) return;
  const p = probe;
  if (p.tmux !== null) {
    screen.append(paragraph(`tmux found at ${p.tmux}. The server launches every pane through it.`));
  } else {
    screen.append(
      paragraph(
        "tmux is not installed yet. The server launches every pane through it, so setup needs it before anything else can run.",
      ),
    );
    const state = prereqState(p);
    if (state === "install") {
      const plan = tmuxInstallPlan(p.platform, p.hasBrew);
      if (plan.kind === "run") {
        actions.append(button(plan.label, () => void runGuarded(() => ipc.installTmux()), true));
      }
      // A "run" plan always has its button; anything else falls through to
      // the manual text below rather than rendering a doomed press.
      if (plan.kind !== "run") {
        screen.append(paragraph("No supported package manager was found. In a terminal:"));
        const code = document.createElement("code");
        code.textContent = plan.command.join(" ");
        screen.append(code);
      }
    } else {
      screen.append(
        paragraph(
          "This Mac has no Homebrew, so there is no button that can install tmux from here. In a terminal, with MacPorts, or from the tmux page linked below:",
        ),
      );
      const code = document.createElement("code");
      code.textContent = plan(p).command.join(" ");
      screen.append(code);
      if (plan(p).docsUrl !== "") {
        actions.append(
          button(
            "Read the tmux docs",
            () =>
              void ipc.openTmuxDocs().catch((err: unknown) => {
                problem = errText(err);
              }),
          ),
        );
      }
    }
    screen.append(
      paragraph(
        "Continue unlocks the moment tmux appears. This page rechecks on its own, so installing in a terminal works without touching anything here.",
      ),
    );
  }
  if (p.serverChoice === "no-bundled") {
    screen.append(paragraph("This build ships no server binary, so point the app at one you already have:"));
    actions.append(button("Choose an existing server...", () => void pickBinary(), true));
  }
  actions.append(button("Back", () => go("welcome")));
  actions.append(button("Continue", () => go("addresses"), true, !canContinue("prerequisites", p, false)));
}

/** tmuxInstallPlan as seen by the manual branch (kept a function so both
 *  render sites read the same plan on every redraw, never a frozen one). */
const plan = (p: Probe) => tmuxInstallPlan(p.platform, p.hasBrew);

function renderAddresses(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(
    paragraph("Port and addresses. The defaults are right for most machines; change anything here, or press Continue."),
  );
  const seeded = effectiveForm(probe?.status?.settings);
  for (const { name } of CONFIG_FIELDS) form[name] = form[name] || seeded[name];
  for (const [name, on] of Object.entries(explicitFields(probe?.status?.settings)) as [keyof ExplicitMap, boolean][]) {
    if (on) explicit[name] = true;
  }
  const grid = document.createElement("div");
  grid.className = "grid w-full grid-cols-2 gap-2.5";
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
    input.disabled = busy;
    input.addEventListener("input", () => {
      form[field.name] = input.value;
      explicit[field.name] = true;
      // The console's rule, whole: an untouched base URL follows the port,
      // because a filled field naming a dead port beside a live one reads as
      // what is about to be written.
      if (field.name === "port" && explicit.baseUrl !== true) {
        form.baseUrl = derivedBaseUrl(input.value);
        const mirror = document.getElementById("field-baseUrl") as HTMLInputElement | null;
        if (mirror) mirror.value = form.baseUrl;
      }
    });
    cell.append(label, input);
    if (field.hint) {
      const h = document.createElement("p");
      h.className = "hint";
      h.textContent = field.hint;
      cell.append(h);
    }
    for (const problemEntry of fieldProblems(probe?.status?.settings, field.name)) {
      const warn = document.createElement("p");
      warn.className = "hint warn-text";
      warn.textContent = problemEntry.reason;
      cell.append(warn);
    }
    grid.append(cell);
  }
  screen.append(grid);
  actions.append(button("Back", () => go("prerequisites")));
  actions.append(button("Continue", () => go("agents"), true));
}

function renderAgents(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(
    paragraph(
      "Install an agent CLI (optional). You can install several, or none: subshells can run a plain terminal right now, with nothing to install, and an agent can be added any time later.",
    ),
  );
  for (const agent of AGENTS) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-3 py-1.5";
    const text = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = agent.name;
    const blurb = document.createElement("span");
    blurb.className = "text-sm text-muted";
    blurb.textContent = ` - ${agent.blurb}`;
    text.append(name, blurb);
    row.append(text);
    if (agentInstalled.has(agent.id)) {
      const done = document.createElement("span");
      done.className = "ok-text";
      done.textContent = "Installed";
      row.append(done);
    } else if (agentInstallPlan(agent.id) !== null) {
      row.append(
        button(
          "Install",
          () =>
            void runGuarded(async () => {
              const r = await ipc.installAgent(agent.id);
              if (r.ok) agentInstalled.add(agent.id);
              return r;
            }),
        ),
      );
    }
    screen.append(row);
  }
  screen.append(
    paragraph(
      "No agent? You don't need one. Subshells can run a plain terminal right now, with nothing to install, and you can add an agent any time later.",
    ),
  );
  actions.append(button("Back", () => go("addresses")));
  actions.append(button("Continue", () => go("run"), true));
}

function renderRun(screen: HTMLElement, actions: HTMLElement): void {
  if (probe === null) return;
  screen.append(
    paragraph("This is what will run:"),
    bulletList([
      "Install the bundled server to ~/.local/bin/subshell-server",
      "Write ~/.config/subshell-server/config.env with the addresses from the previous step",
      "Register it to start at login, and start it",
    ]),
  );
  for (const row of runRows(probe)) {
    const line = document.createElement("p");
    line.className = row.done ? "row-done" : "row-pending";
    line.textContent = `${row.done ? "✓" : "…"} ${row.label}`;
    screen.append(line);
  }
  if (running) {
    screen.append(paragraph("Setting up. This page keeps checking; the words appear below as each part reports back."));
  } else {
    actions.append(button("Back", () => go("agents")));
    actions.append(button("Set up and start", () => void startSetup(), true, !canContinue("run", probe, false)));
    if (probe.tmux === null) {
      screen.append(
        paragraph(
          "tmux is still missing; the button waits because the server refuses to configure or start without it.",
        ),
      );
    }
  }
}

async function startSetup(): Promise<void> {
  // NOT runGuarded: the chain's own promise owns the state, and the interval
  // must keep probing while it runs (that is what ticks the rows). The chain
  // in Rust stops at the first failure and the probe then names the
  // remainder, so there is nothing to sequence here.
  if (busy || running) return;
  running = true;
  problem = "";
  showOutput(null);
  render();
  try {
    const result = await ipc.setup(configPayload(form, explicit));
    showOutput(result);
  } catch (err) {
    problem = errText(err);
  } finally {
    running = false;
  }
  await refresh().catch(() => {});
  render();
}

function renderDone(screen: HTMLElement, actions: HTMLElement): void {
  screen.append(
    paragraph(
      "Subshell is running on this machine. The dashboard's own wizard will walk through creating your account.",
    ),
  );
  actions.append(
    button(
      "Open dashboard",
      () =>
        void runGuarded(async () => {
          await ipc.openMain();
          return null;
        }, true),
      true,
    ),
  );
  actions.append(
    button(
      "Go to status page",
      () =>
        void runGuarded(async () => {
          await ipc.openConsole();
          return null;
        }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Render + poll
// ---------------------------------------------------------------------------

function pickBinary(): Promise<void> {
  return (async () => {
    const chosen = await openDialog({ multiple: false, directory: false, title: "Choose subshell-server" });
    // Falsy, not "not a string": a cancel must not clear the stored choice.
    if (!chosen) return;
    try {
      await ipc.setServerBin(chosen);
    } catch (err) {
      problem = errText(err);
    }
    await refresh().catch(() => {});
    render();
  })();
}

function render(): void {
  el("problem").textContent = problem;
  if (probe === null) {
    el("rail").textContent = "";
    el("screen").textContent = "";
    el("screen-actions").textContent = "";
    el("screen").append(paragraph("Checking this machine..."));
    return;
  }
  // Facts over footprints: a Run whose rows all ticked IS Done, even if the
  // human's button press raced the last poll. Decided before drawing, so no
  // screen is ever painted for a step the machine has left behind.
  if (step === "run" && runRows(probe).every((r) => r.done)) step = "done";

  const rail = el("rail");
  rail.textContent = "";
  STEP_ORDER.forEach((id, i) => {
    // `li`, not `span`: the rail is a list in the markup too, so its
    // aria-label sits on an element that can carry one. Tailwind's preflight
    // strips the bullet and the padding, so it paints exactly as before.
    const s = document.createElement("li");
    const state = id === step ? "current" : i < stepIndex(step) ? "done" : "locked";
    s.className = `rail-step ${state}`;
    s.textContent = `${STEP_LABELS[id]}`;
    rail.append(s);
  });

  const screen = el("screen");
  const actions = el("screen-actions");
  screen.textContent = "";
  actions.textContent = "";
  const views: Record<WizardStepId, (s: HTMLElement, a: HTMLElement) => void> = {
    welcome: renderWelcome,
    prerequisites: renderPrerequisites,
    addresses: renderAddresses,
    agents: renderAgents,
    run: renderRun,
    done: renderDone,
  };
  views[step](screen, actions);
}

async function tick(): Promise<void> {
  // Running is unskippable in both conditions: during a Run this interval IS
  // the checklist's updater, the way the console's settle loop is for its own
  // actions - single-flight by construction, because only startSetup sets the
  // flag and it is awaited through to its final render.
  if ((busy || document.hidden) && !running) return;
  try {
    await refresh();
  } catch {
    return; // a failed background probe keeps the last truth on screen
  }
  render();
}

void (async () => {
  try {
    // The first probe through a local: TS cannot see that `refresh` assigns
    // the module variable, and `firstOpenStep` wants the non-null it already
    // has; threading the value beats both a cast and a re-probe.
    const p = await ipc.probe();
    probe = p;
    problem = p.error ?? "";
    step = firstOpenStep(p);
  } catch (err) {
    problem = errText(err);
  }
  render();
  setInterval(() => void tick(), POLL_MS);
})();
