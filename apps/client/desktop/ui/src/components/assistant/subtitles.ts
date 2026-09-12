/**
 * One sentence per screen, in the assistant's voice.
 *
 * These are the `step-screens.ts` `body` lines, carried across rather than
 * rewritten — they were reviewed copy, and the screens they belonged to are
 * the screens this assistant shows. What changed is the shape around them: a
 * subtitle is at most two lines (spec 2026-09-11 § 3.1), so the longer
 * explanations became the screens' own notes instead of a `notes` array on a
 * card.
 *
 * Sentence case, and they say what will happen or why, never how.
 */

import type { NodeSettings, Probe } from "@/lib/ipc";
import type { NodeScreenId } from "@/lib/node-assistant-state";

/** "this Mac" on macOS, "this machine" elsewhere — mid-sentence, so lower case. */
export function hereLower(platform: string): string {
  return platform === "darwin" ? "this Mac" : "this machine";
}

/**
 * The screen's subtitle.
 *
 * @param platform - `"darwin"` or anything else; the caller derives it (the
 * client's probe carries no platform field, unlike the server app's)
 */
export function subtitleFor(
  screen: NodeScreenId,
  probe: Probe | undefined,
  settings: NodeSettings | undefined,
  platform: string,
): string {
  const here = hereLower(platform);
  switch (screen) {
    case "connect":
      return "Enter the address of the Subshell server this app should show.";
    case "install-agent":
      // Two very different situations share this step, and the difference
      // decides whether an install is offered at all: a binary that answered
      // `version` but not `status --json` must NOT route to enroll, because a
      // transient read failure would then overwrite a live config.
      return probe?.agent
        ? "An agent was found on this machine, but it could not report its status."
        : `No subshell agent was found on ${here}.`;
    case "enroll":
      return probe?.status?.nodeId
        ? `Register ${here} again, with a different control plane or as a new node.`
        : `${probe?.agent ? "This machine has an agent but is" : "This machine is"} not registered with a control plane yet.`;
    case "service":
      if (probe?.step === "offline") {
        return "The service manager reports the agent as running, but no local daemon is heartbeating.";
      }
      if (probe?.step === "stopped") return "The background service is installed, but the agent is not running.";
      if (probe?.step === "no-service")
        return `${probe.status?.nodeId ? "This machine is registered, but nothing keeps its agent running." : "Nothing keeps the agent running."}`;
      // A step this build predates: say so plainly rather than asserting
      // something about the machine.
      return `This app does not recognise the state "${probe?.step ?? "unknown"}", which usually means it is older than the agent it is managing.`;
    case "connected": {
      const where = probe?.status?.serverUrl ?? settings?.planeUrl;
      return where
        ? `Enrolled and reporting to ${where}. Subshells can be launched here from the browser.`
        : "Enrolled, and the agent is online. Subshells can be launched here from the browser.";
    }
    case "reset":
      // Says what is deleted rather than where it lives. The title deliberately
      // names no machine (node-assistant-state.ts explains why), and a subtitle
      // that put "this Mac" straight back under it would undo that.
      return "Delete this node's configuration, its key and its data. Nothing else on this computer is touched.";
  }
}
