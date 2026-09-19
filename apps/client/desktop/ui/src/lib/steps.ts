/**
 * The step machine's vocabulary: the closed set of steps, and the three facts
 * every screen reads off a probe.
 *
 * There are no URLs in this app — one window and a step machine — so this
 * replaces a router. {@link PROBE_STEPS} is the runtime list beside
 * `ProbeStep`, derived from the same serde values `src-tauri/src/control.rs`
 * emits, so anything that has to iterate the steps (the label table, its test)
 * has one edit site rather than two that drift.
 */
import type { Probe, ProbeStep } from "@/lib/ipc";

/**
 * Every `ProbeStep` the Rust side can emit, in the order a machine walks them.
 *
 * Kebab-case, matching `#[serde(rename_all = "kebab-case")]` on `ProbeStep`.
 */
export const PROBE_STEPS: readonly ProbeStep[] = [
  "no-agent",
  "not-enrolled",
  "no-service",
  "stopped",
  "offline",
  "online",
];

/**
 * A step the USER chose rather than one the machine implies.
 *
 * Today only `enroll`, reached from an already-registered machine: re-enrolling
 * is something a user asks for, never something a probe implies.
 */
export type UserStep = "enroll";

/** What the step card can be showing. */
export type StepKey = ProbeStep | UserStep;

/** One word for where this machine stands, keyed by the step enum. */
const STEP_LABELS: Record<ProbeStep, string> = {
  online: "Online",
  offline: "Offline",
  stopped: "Service stopped",
  "no-service": "Not running in the background",
  "not-enrolled": "Not enrolled",
  "no-agent": "No node",
};

/** The chip's tone, which is also the dot's colour. */
export type Tone = "ok" | "warn" | "bad" | "neutral";

const STEP_TONES: Record<ProbeStep, Tone> = {
  online: "ok",
  offline: "bad",
  stopped: "warn",
  "no-service": "warn",
  "not-enrolled": "neutral",
  "no-agent": "neutral",
};

/**
 * The chip's word for a probe's step.
 *
 * `Unknown` covers a step this build predates — the app is older than the node
 * CLI it is managing — rather than asserting something about the machine.
 */
export function stepLabel(step: ProbeStep | undefined): string {
  return step === undefined ? "Unknown" : (STEP_LABELS[step] ?? "Unknown");
}

export function stepTone(step: ProbeStep | undefined): Tone {
  return step === undefined ? "neutral" : (STEP_TONES[step] ?? "neutral");
}

/**
 * Whether the installed service definition would take live panes down with it.
 *
 * Fails CLOSED on `unknown`, the way the CLI's own guard does: an unreadable
 * definition is not evidence of safety. A machine with no service installed is
 * not at risk, and is also a machine none of the teardown actions are offered
 * on.
 */
export function paneRisk(probe: Probe | undefined): boolean {
  return probe?.service?.installed === true && probe.service.paneSafety !== "keeps";
}

/**
 * Whether rewriting the definition would itself cost the panes it is repairing.
 *
 * True on macOS only, and the asymmetry is launchd's: systemd re-reads a
 * rewritten unit under the running daemon (`daemon-reload`, then an `enable
 * --now` that leaves an active unit alone), where launchd has no reload at all
 * — `service install` boots the loaded job OUT and bootstraps the new plist.
 * Booting out a job whose LOADED definition predates `AbandonProcessGroup`
 * takes its whole process group, which is every pane on this machine. The Rust
 * side reports the platform half as `rewriteTearsDown`; the pane half is the
 * same fact the other teardown actions read.
 */
export function rewriteKillsPanes(probe: Probe | undefined): boolean {
  return paneRisk(probe) && probe?.rewriteTearsDown === true;
}

/**
 * Whether a control-plane URL points at THIS machine.
 *
 * Mirrors `is_loopback_server` in `src-tauri/src/control.rs`, host for host, so
 * the advisory under the field and the confirmation the Rust side raises agree
 * about what counts. It is never a block: running the control plane and a node
 * on one box is exactly what the desktop pair exists for.
 */
export function isLoopback(raw: string | null | undefined): boolean {
  let host: string;
  try {
    host = new URL(String(raw).trim()).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  );
}
