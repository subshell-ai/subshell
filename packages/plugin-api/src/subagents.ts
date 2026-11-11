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
 * Pane operations the host hands a hook integration that drives its harness's
 * own agent picker. The plugin runs in the control plane, so it cannot open a
 * terminal itself; these are the only two acts it needs, and neither submits
 * a prompt on its own.
 */
export interface HarnessSubagentPane {
  /** The parent pane's current screen with ANSI stripped, exactly as painted. */
  read(): Promise<string>;
  /**
   * Type raw bytes into the pane's own input. Nothing is appended or
   * translated: send `\r` for Enter, `\u001b[1;3D` for Alt+Left, and so on.
   */
  type(text: string): Promise<void>;
}

/** What the host hands an integration's {@link HarnessSubagentSupport.select}. */
export interface HarnessSubagentSelectInput {
  /** The child to show, or null to return the parent itself */
  agentId: string | null;
  /** The roster the child came from, server-stamped and bounded */
  agents: readonly HarnessSubagentView[];
  /** The parent terminal this selection must happen in */
  pane: HarnessSubagentPane;
}

/** What the integration must report back after the harness actually switched. */
export interface HarnessSubagentSelectResult {
  /** The view the harness showed when the act finished; null for the parent */
  selectedId: string | null;
}

/**
 * A hook integration's own way to move its terminal's view. This is for
 * harnesses whose picker exists only inside their TUI (Codex's `/subagents`,
 * for example): the integration reads the pane, sends the picker's keys, and
 * reports the view it verified. Extension integrations use the report-loop
 * command instead, because their bridge can call the harness's real API.
 */
export type HarnessSubagentSelect = (input: HarnessSubagentSelectInput) => Promise<HarnessSubagentSelectResult>;

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
  /**
   * A hook integration's own picker driver, when it has one. Requires
   * `navigation: "native"`; the host uses it instead of queueing a command.
   */
  select?: HarnessSubagentSelect;
}
