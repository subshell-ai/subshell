import type { SshActorSide } from "./ssh-actor-side.js";

/**
 * Database table schema for MANAGED SSH terminal panes (SSH-SUPPORT.md §4,
 * Persistence). One row per live-or-recent managed pane, keyed by the
 * subshell id it shares with the ordinary `subshells` row that carries its
 * tmux/lifecycle facts.
 *
 * The row exists because the ordinary pane's ownership and shares DO NOT
 * confer SSH access: "no implicit access via ordinary pane ownership". Every
 * generic pane surface consults this row (through the SSH policy) before it
 * reads or writes; a pane with no row here is an ordinary pane and the policy
 * never runs.
 */
export interface SshPaneTable {
  /** The subshell id this managed pane IS (PK, cascades with `subshells`) */
  subshellId: string;
  /** Connection the SSH foreground process belongs to (CASCADE: deleting the connection while its panes run is refused upstream, so this only lands on already-dead panes) */
  connectionId: string;
  /**
   * Connection revision pinned at open. A config edit mid-session does NOT
   * move the live terminal (its argv was built from this revision); the pin
   * exists so reconciliation and display can say which route is actually
   * connected.
   */
  connectionRevision: number;
  /** Who opened the pane. Human-opened panes start in human control; agent-opened ones in agent control (spec §3). */
  initiatedBy: SshActorSide;
  /** Grant that authorized an AGENT-opened pane; null for human-opened panes */
  grantId: string | null;
  /** The opening credential's api-key identity for agent-opened panes; null for human-opened */
  apiKeyId: string | null;
  /**
   * Current input-control holder. `human` blocks agent reads AND writes on
   * every API/stream (recorded output may become visible after a return);
   * only humans return control to agents.
   */
  controlOwner: SshActorSide;
  /**
   * The plane's authoritative counter for this pane's input control, mirrored
   * on the node (transitions go through `ssh_input_control`). Every managed
   * input write carries at least this value; takeover/revocation raise it,
   * which fences stale queued input AT THE NODE, not just at the plane.
   */
  controlGeneration: number;
  /**
   * Rotation counter for the pane's log file. Byte-cursor readers hold
   * `<generation>:<offset>` semantics: a generation change means the offset
   * no longer addresses what it addressed, which is the explicit
   * cursor-expired/reset signal the §3 rotation rule requires.
   */
  logGeneration: number;
  /** ISO 8601 open timestamp (DB default) */
  createdAt: string;
}

/** Insert shape: DB default fills `createdAt`; control starts at generation 1, log at 1. */
export type NewSshPane = Omit<SshPaneTable, "createdAt"> & { createdAt?: string };

/** Update shape: control/log generations and control owner move over time; the connection pin never does. */
export type SshPaneUpdate = Partial<Pick<SshPaneTable, "controlOwner" | "controlGeneration" | "logGeneration">>;
