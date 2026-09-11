/**
 * The first-run wizard's decisions, pure (§ 5 of the 2026-09-10 spec).
 *
 * Separate from the wizard page for the same reason `config-form.ts` and
 * `installers.ts` are separate from the console: this is the part with a
 * contract rather than a rendering, and it is the part worth testing without
 * a webview.
 *
 * Page state (which step the human navigated to) is deliberately NOT here:
 * only the facts a probe licenses, so the same functions decide on a reopen
 * after a quit, a crash, or a machine changed from a terminal. A wizard that
 * remembered where you were would be a second source of truth about a machine
 * this app does not own; the probe already is that truth.
 */
import type { Probe } from "./ipc";

/** The wizard's steps, in rail order. */
export type WizardStepId = "welcome" | "prerequisites" | "addresses" | "agents" | "run" | "done";

/** How the Prerequisites step presents tmux, off the one probe round trip. */
export type PrereqState =
  /** tmux answers. */
  | "found"
  /** missing, and the platform has an installer this app may run */
  | "install"
  /** missing, and the honest answer is docs plus the poll */
  | "manual";

/** Rail order of the steps, so the page draws the "Step N of 5" position from one list. */
const STEP_ORDER: WizardStepId[] = ["welcome", "prerequisites", "addresses", "agents", "run", "done"];

/**
 * Whether tmux is there, installable from here, or a manual step.
 *
 * Three states because a button the app cannot honour is worse than none:
 * the Mac-without-Homebrew machine gets the MacPorts line and the docs, not
 * a press that spawns something doomed. This only says whether a plan exists;
 * `installers.ts` owns the plan itself.
 */
export function prereqState(probe: Probe): PrereqState {
  if (probe.tmux) return "found";
  // The same two facts tmuxInstallPlan branches on, so "install" always
  // means the button this step renders can actually be pressed.
  if (probe.platform === "darwin") return probe.hasBrew ? "install" : "manual";
  return "install"; // the linux plan is a package-manager search; installers.ts owns the truth
}

/**
 * Which step a reopened wizard opens on, decided from the machine's facts
 * rather than from where the last session happened to be.
 */
export function firstOpenStep(probe: Probe): WizardStepId {
  // Resume where the facts say the human is: each rung already met is not a
  // step to walk again. Agents never "complete" (optional), so it is only
  // ever landed on, never skipped past by a fact.
  if (probe.next === "ready") return "done";
  if (!probe.tmux) {
    // No tmux: welcome only for a machine nothing has touched yet; a
    // half-run machine resumes at the gate that actually binds it.
    return probe.server === null && probe.status === null ? "welcome" : "prerequisites";
  }
  if (!probe.status?.configEnv?.exists) return "addresses";
  return "run";
}

/** One row of the Run step's checklist. */
export interface RunRow {
  id: "server" | "config" | "service" | "running";
  label: string;
  done: boolean;
}

/**
 * The Run checklist, ticked from probe facts and never from the chain's
 * progress: the chain runs in Rust, and the same facts that drive `probe.next`
 * are the ones the rows show (spec § 5's table). Optimism here would tick a
 * row the CLI then refuses, which is exactly the "stopped with no explanation"
 * class the console's pass-through rule exists to prevent.
 */
export function runRows(probe: Probe): RunRow[] {
  return [
    { id: "server", label: "Server installed", done: probe.server !== null },
    { id: "config", label: "Configuration written", done: probe.status?.configEnv?.exists === true },
    { id: "service", label: "Service registered", done: probe.service?.installed === true },
    { id: "running", label: "Server running", done: probe.next === "ready" },
  ];
}

/**
 * Whether the Continue/press affordance is live on a step.
 *
 * The gate stops forward motion only: the window stays a normal window, so
 * close, quit and the menu live on every step (spec R12). Each case mirrors
 * where the CLI itself will refuse, so the wizard never bars a press that
 * would work and never offers one that would not.
 */
export function canContinue(step: WizardStepId, probe: Probe | null, busy: boolean): boolean {
  if (probe === null) return false; // no facts, no claims
  if (busy) return false;
  switch (step) {
    case "welcome":
      return true;
    case "prerequisites":
      return probe.tmux !== null;
    case "addresses":
    case "agents":
      return true;
    case "run":
      // The chain's one hard stop. Install is step one of the chain itself,
      // so a missing server is not a reason to bar the press; a missing tmux
      // is (init and service install both refuse without it), and that is
      // the only gate. One condition, no cleverness: a guard that is wrong
      // in no case beats a ternary nobody can read.
      return probe.tmux !== null;
    case "done":
      return probe.next === "ready";
  }
}

/** Rail labels, one per step. */
export const STEP_LABELS: Record<WizardStepId, string> = {
  welcome: "Welcome",
  prerequisites: "Prerequisites",
  addresses: "Addresses",
  agents: "Agents",
  run: "Set up",
  done: "Done",
};

export { STEP_ORDER };
