/**
 * The node assistant's decisions, pure (spec 2026-09-12 § 6.4).
 *
 * Which screen this machine sees, what that screen is called, and which
 * service verb it offers. Page state — the action runner, the enroll form,
 * the screen the user asked for — stays in `app.tsx`; only facts a probe and
 * the app's own settings license live here, so the window renders honestly on
 * a reopen and every decision is testable without a webview.
 *
 * This replaces the card page's `override ?? probe?.step ?? null`: the same
 * idea, but it answers a SCREEN rather than a step, because two probe steps
 * (`stopped`, `offline`) and one absent plane address all resolve to screens
 * that ask one question each.
 */
import type { NodeSettings, Probe, ProbeStep } from "@/lib/ipc";

/** The assistant's screens. One decision each (spec § 6.4). */
export type NodeScreenId = "connect" | "install-agent" | "enroll" | "service" | "connected" | "reset";

/**
 * A screen the USER chose rather than one the machine implies.
 *
 * Re-enrolling and resetting are things a person asks for from a machine that
 * is already working; no probe ever implies either.
 */
export type NodeUserScreen = "enroll" | "reset";

/**
 * Which screen this machine sees.
 *
 * A plane address comes FIRST, ahead of everything the probe says: without
 * one this app has nothing to show in its other window, and "enroll this
 * machine" is a question about a server the person has not named yet. Then a
 * screen the user explicitly asked for, then the probe's own step.
 *
 * `null` while nothing has been read — the frame renders its checking state
 * rather than guessing at a screen it may have to replace a moment later.
 *
 * @param probe - the machine's own state, `undefined` before the first read
 * @param settings - this app's settings, `undefined` before the first read
 * @param override - a screen the user asked for, or null
 */
export function screenFor(
  probe: Probe | undefined,
  settings: NodeSettings | undefined,
  override: NodeUserScreen | null,
): NodeScreenId | null {
  if (!settings) return null;
  if (!settings.planeUrl) return "connect";
  if (override) return override;
  if (!probe) return null;
  switch (probe.step) {
    case "no-agent":
      return "install-agent";
    case "not-enrolled":
      return "enroll";
    case "no-service":
    case "stopped":
    case "offline":
      return "service";
    case "online":
      return "connected";
    default:
      // A step this build predates: the machine is saying something this app
      // does not understand, which is the service screen's territory (it is
      // the one that shows the facts and the last output).
      return "service";
  }
}

/** "This Mac" on macOS, "This Machine" everywhere else — Title Case, for a title. */
function here(platform: string): string {
  return platform === "darwin" ? "This Mac" : "This Machine";
}

/**
 * The screen's title, in the assistant's voice (spec 2026-09-11 § 3.2: Title
 * Case, one line, no trailing punctuation).
 *
 * The service screen names WHICH failure it is looking at, because "start the
 * service" and "the service stopped answering" are different problems with
 * the same button.
 *
 * @param platform - `"darwin"` or anything else; the caller derives it
 */
export function screenTitle(screen: NodeScreenId, probe: Probe | undefined, platform: string): string {
  switch (screen) {
    case "connect":
      return "Connect to a Server";
    case "install-agent":
      return "Install the Agent";
    case "enroll":
      return `Enroll ${here(platform)}`;
    case "service":
      if (probe?.step === "offline") return "The Node Service Isn't Responding";
      if (probe?.step === "stopped") return "The Node Service Is Stopped";
      return "Start the Node Service";
    case "connected":
      return `${here(platform)} Is a Node`;
    case "reset":
      // NOT "Reset This Mac", and this is the one title that takes no
      // platform word. Two things were wrong with that spelling, and the
      // operator read the second off a screenshot on 2026-09-12.
      //
      // It OVERCLAIMED. This deletes Subshell's own node state — the config,
      // the node key, the data directory — and touches nothing else on the
      // computer. A label that reads as "erase this computer" is alarming
      // about the wrong thing, which is worse than being alarming.
      //
      // And a label ENDING on "Mac" reads as a truncated "Machine", against
      // a sibling string that really is "This Machine" and under the
      // trailing ellipsis a button that opens a screen carries. Naming the
      // location differently does not fix that; not ending there does.
      //
      // "Node" is this project's own word for a machine that runs agents,
      // which is exactly what is being reset, so it is both the precise
      // term and the unambiguous one.
      return "Reset This Node";
  }
}

/** The one service verb a step calls for, or null when the step needs none. */
export function serviceAction(step: ProbeStep): { label: string; verb: "install" | "start" | "restart" } | null {
  switch (step) {
    case "no-service":
      return { label: "Install and Start", verb: "install" };
    case "stopped":
      return { label: "Start", verb: "start" };
    case "offline":
      return { label: "Restart", verb: "restart" };
    default:
      return null;
  }
}
