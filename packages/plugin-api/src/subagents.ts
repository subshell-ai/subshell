/** What a reported agent is doing, as the harness itself says. */
export type HarnessSubagentStatus = "running" | "waiting" | "idle";

/** The full value set, for anything that validates or iterates (one edit site). */
export const HARNESS_SUBAGENT_STATUSES: readonly HarnessSubagentStatus[] = ["running", "waiting", "idle"];

/** A harness agent belongs to an existing terminal, never to a new subshell. */
export interface HarnessSubagent {
  /** Harness-side identifier; unique among this parent's current children */
  id: string;
  /** Parent agent within the harness, when the harness nests */
  parentId?: string;
  /** Display name as the harness reports it; generic ones render numbered */
  name: string;
  /** What the harness says this agent is doing */
  status: HarnessSubagentStatus;
  /**
   * The harness's own one-line label for what this child was asked to do,
   * when the harness has one to give. The host bounds it and normalizes it
   * like a name; it is the harness's summary of the task, never the prompt
   * text or anything read from the child's transcript.
   */
  activity?: string;
}

/**
 * A reported child as the control plane SERVES it: what the harness said, plus
 * the server's own observation of when the child appeared. Viewers derive
 * elapsed time from that stamp against their own clock, so a roster that
 * stopped being polled ages honestly instead of freezing at its last read.
 */
export interface HarnessSubagentView extends HarnessSubagent {
  /** Epoch milliseconds of when the server first saw this child; never sent by a harness */
  startedAt: number;
}

/** How the plugin learns about children: harness lifecycle hooks, or a loaded extension. */
export type HarnessSubagentDiscovery = "hooks" | "extension";

export const HARNESS_SUBAGENT_DISCOVERIES: readonly HarnessSubagentDiscovery[] = ["hooks", "extension"];

/** Whether the sidebar can move the parent's own view to a child, or the harness keeps that in-app. */
export type HarnessSubagentNavigation = "native" | "unavailable";

export const HARNESS_SUBAGENT_NAVIGATIONS: readonly HarnessSubagentNavigation[] = ["native", "unavailable"];

/** The control-plane view of one parent's children at a moment; transient, never stored. */
export interface HarnessSubagentSnapshot {
  /** The reported children with server stamps, bounded by the host (256 per parent) */
  agents: HarnessSubagentView[];
  /** Which child the PARENT's terminal is showing; null for the main agent */
  selectedId: string | null;
  /** Whether this actor may move the parent's view (capability AND permission) */
  canSelect: boolean;
  /** Why `canSelect` is false, phrased for the person at the keyboard */
  unavailableReason?: string;
}

/**
 * What a plugin declares about its harness's child agents. The host uses
 * `discovery`/`navigation` to decide what the sidebar may offer; `setup`, when
 * the harness needs a one-time human act (trusting hooks, installing an
 * extension), is the copy the preset editor shows for that act.
 */
export interface HarnessSubagentSupport {
  /** How subagent lifecycle events reach Subshell */
  discovery: HarnessSubagentDiscovery;
  /** Whether subshell may navigate the parent's own view to a child */
  navigation: HarnessSubagentNavigation;
  /** One-time user action required for reporting to work, if any */
  setup?: string;
}
