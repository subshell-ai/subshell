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
export type NodeScreenId =
  | "connect"
  | "install-agent"
  | "enroll"
  | "service"
  | "connected"
  | "reset"
  | "about"
  | "app-update";

/**
 * A screen the USER chose rather than one the machine implies.
 *
 * Re-enrolling and resetting are things a person asks for from a machine that
 * is already working; no probe ever implies either. `about` joined them when
 * the permanent colophon under every screen was removed (operator's call,
 * 2026-09-12): what this app is and under what terms is something a person
 * ASKS for, not something that sits under the question being asked.
 *
 * `app-update` joined them on 2026-09-15 for the same reason and one more: it
 * is the only screen here whose facts come from the NETWORK rather than from
 * this machine, so no probe could imply it even in principle. Reached from the
 * tray's "Check for Updates…" and from the Connected screen's disclosure.
 */
export type NodeUserScreen = "enroll" | "reset" | "about" | "app-update";

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

/**
 * ONE word for where you are, on both platforms (operator's call, 2026-09-12).
 *
 * There used to be a `darwin ? "This Mac" : "This Machine"` split here. The
 * macOS feel this assistant is after comes from its SHAPE — one decision per
 * full-window screen, fixed button positions, screens that ask nothing never
 * appearing — not from its vocabulary. "Mac" bought very little of that and
 * cost a branch, a test matrix on every string, and one real misreading: a
 * label ending on "Mac", which is a prefix of the other platform's own word,
 * was reported as a truncated layout bug.
 */
const HERE = "This Machine";

/**
 * The screen's title, in the assistant's voice (spec 2026-09-11 § 3.2: Title
 * Case, one line, no trailing punctuation).
 *
 * The service screen names WHICH failure it is looking at, because "start the
 * service" and "the service stopped answering" are different problems with
 * the same button.
 *
 */
export function screenTitle(screen: NodeScreenId, probe: Probe | undefined): string {
  switch (screen) {
    case "connect":
      return "Connect to a Server";
    case "install-agent":
      return "Install the Agent";
    case "enroll":
      return `Enroll ${HERE}`;
    case "service":
      if (probe?.step === "offline") return "The Node Service Isn't Responding";
      if (probe?.step === "stopped") return "The Node Service Is Stopped";
      return "Start the Node Service";
    case "connected":
      return `${HERE} Is a Node`;
    case "reset":
      // The one title that names no machine at all, on either platform
      // (operator's call, 2026-09-12). It was "Reset This Mac", and that was
      // wrong twice over.
      //
      // It OVERCLAIMED. This deletes Subshell's own state — the config, the
      // node key, the data directory — and touches nothing else on the
      // computer. A destructive label that reads as "erase this computer" is
      // alarming about the wrong thing, which is worse than being alarming,
      // because it teaches people not to trust what these labels say.
      //
      // And it read as TRUNCATED: "Mac" is a prefix of "Machine", the
      // sibling string on Linux really is "This Machine", and the label ends
      // there under the ellipsis a button that opens a screen carries. That
      // is how it was reported — as a layout bug.
      //
      // Naming WHAT IS RESET fixes both and needs no platform word:
      // everything this app does is on this machine, so saying so was only
      // ever redundant (operator's call, 2026-09-12). The two apps do NOT
      // share a string — Subshell Server's twin reads "Reset this server",
      // because the two resets destroy different things and one label over
      // both is the overloading the vocabulary rule exists to prevent.
      return "Reset this client";
    case "about":
      return "About Subshell Client";
    case "app-update":
      // The APP, not the node agent it wraps. Both can be out of date at once
      // and they are updated by different acts — one replaces this
      // application, the other replaces `~/.local/bin/subshell` through that
      // binary's own `update --from` — so the two never share a title.
      return "Update Subshell Client";
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
