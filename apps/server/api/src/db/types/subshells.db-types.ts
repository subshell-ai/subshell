import type { SubshellStatus } from "./subshell-status.js";

/**
 * Database table schema for agent subshells.
 *
 * The DB row is a record of intent; liveness is derived from the tmux
 * subshell at query time (tmux is the source of truth).
 */
export interface SubshellTable {
  /** Unique subshell id (uuid) */
  id: string;
  /** Owning user id */
  userId: string;
  /**
   * Preset launched with; NULL = a presetless launch (the empty-preset path,
   * spec 2026-09-13) — also the state left by deleting the preset it used.
   */
  presetId: string | null;
  /** Harness plugin id used to launch this subshell */
  harnessId: string;
  /** Human-friendly subshell name (defaults to the created timestamp) */
  name: string;
  /** Absolute working directory the harness runs in */
  workingDir: string;
  /** tmux server socket name used for this subshell (subshell-<short>) */
  tmuxSocket: string | null;
  /** Consistent status; "running" while tmux is alive */
  status: SubshellStatus;
  /** ISO 8601 timestamp when the subshell was created */
  createdAt: string;
  /** ISO 8601 timestamp when the subshell ended (or null while running) */
  endedAt: string | null;
  /** ISO timestamp of the last bytes written to the subshell log (null = none yet) */
  lastOutputAt: string | null;
  /**
   * DEPRECATED (spec 2026-09-03 follow-up): the operator-note feature was
   * removed with its UI, endpoint, and MCP tool. The column is read and
   * written by nothing; it stays so a rollback finds its data.
   */
  notes: string | null;
  /** 1 = pane process alive; 0 = dead/paused */
  alive: number;
  /** Harness exit status when it died (null = n/a) */
  exitCode: number | null;
  /** ISO timestamp of the last process start */
  startedAt: string | null;
  /** Consecutive auto-restarts (exponential backoff) */
  backoffCount: number;
  /** ISO timestamp when a backoff-delayed auto-restart is due */
  nextRestartAt: string | null;
  /** 1 = auto-restart this subshell on unexpected exit */
  restartOnExit: number;
  /** 1 = operator chose this name; the pane-title sweep leaves it alone */
  nameLocked: number;
  /** 1 = push the owner on attention events (done / approval / exit) */
  notify: number;
  /** ISO ts of the "waiting for you" event (null = not waiting). See migration 0014. */
  waitingSince: string | null;
  /**
   * Urgency (see notify.service) of the last delivered push attempt the
   * owner has not answered by opening the pane; NULL = nothing unseen.
   * See migration 0035.
   */
  lastPushUrgency: number | null;
  /**
   * Harness conversation id pinned for restart-resume (null = pre-feature
   * row, non-resume harness, or nothing pinned yet). See migration 0013.
   */
  harnessSessionId: string | null;
  /** better-auth api-key id backing this subshell's MCP token (null = none yet) */
  apiKeyId: string | null;
  /** Node the subshell runs on ('local' = control-plane host) */
  nodeId: string;
  /**
   * DEPRECATED (spec 2026-09-03): the terminal history cap moved per-USER
   * (`user_meta.terminal_replay_lines`, migration 0020). This column is
   * read and written by nothing; it stays so a rollback finds its data.
   * See migration 0018 for the original design.
   */
  terminalReplayLines: number | null;
}

/**
 * Insert shape: DB defaults fill createdAt/endedAt/status and the liveness /
 * auto-restart columns (alive, backoffCount, restartOnExit) when omitted.
 */
export type NewSubshell = Omit<
  SubshellTable,
  | "presetId"
  | "createdAt"
  | "endedAt"
  | "status"
  | "lastOutputAt"
  | "notes"
  | "alive"
  | "backoffCount"
  | "restartOnExit"
  | "exitCode"
  | "startedAt"
  | "nextRestartAt"
  | "apiKeyId"
  | "nameLocked"
  | "harnessSessionId"
  | "notify"
  | "waitingSince"
  | "lastPushUrgency"
  | "nodeId"
  | "terminalReplayLines"
> & {
  /** Preset launched with; omitted = NULL (presetless launch). Defaults on insert. */
  presetId?: string | null;
  /** Node to launch on; omitted = DB default 'local' */
  nodeId?: string;
  /** Per-subshell terminal replay cap; omitted = NULL = instance default */
  terminalReplayLines?: number | null;
  harnessSessionId?: string | null;
  status?: SubshellStatus;
  lastOutputAt?: string | null;
  notes?: string | null;
  nameLocked?: number;
  notify?: number;
  waitingSince?: string | null;
  lastPushUrgency?: number | null;
  alive?: number;
  backoffCount?: number;
  restartOnExit?: number;
  exitCode?: number | null;
  startedAt?: string | null;
  nextRestartAt?: string | null;
  apiKeyId?: string | null;
};
export type SubshellUpdate = Partial<Omit<SubshellTable, "id" | "userId">>;
