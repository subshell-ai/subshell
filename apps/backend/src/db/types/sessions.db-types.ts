import type { SessionStatus } from "./session-status.js";

/**
 * Database table schema for agent sessions.
 *
 * The DB row is a record of intent; liveness is derived from the tmux
 * session at query time (tmux is the source of truth).
 */
export interface SessionTable {
  /** Unique session id (uuid) */
  id: string;
  /** Owning user id */
  userId: string;
  /** Profile used to launch this session */
  profileId: string;
  /** Harness plugin id used to launch this session */
  harnessId: string;
  /** Human-friendly session name (defaults to the created timestamp) */
  name: string;
  /** Absolute working directory the harness runs in */
  workingDir: string;
  /** tmux server socket name used for this session (mote-<short>) */
  tmuxSocket: string | null;
  /** Consistent status; "running" while tmux is alive */
  status: SessionStatus;
  /** ISO 8601 timestamp when the session was created */
  createdAt: string;
  /** ISO 8601 timestamp when the session ended (or null while running) */
  endedAt: string | null;
  /** ISO timestamp of the last bytes written to the session log (null = none yet) */
  lastOutputAt: string | null;
  /** Free-text operator note (null = none) */
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
  /** 1 = auto-restart this session on unexpected exit */
  restartOnExit: number;
  /** 1 = operator chose this name; the pane-title sweep leaves it alone */
  nameLocked: number;
  /** 1 = push the owner on attention events (done / approval / exit) */
  notify: number;
  /** ISO ts of the "waiting for you" event (null = not waiting). See migration 0014. */
  waitingSince: string | null;
  /**
   * Harness conversation id pinned for restart-resume (null = pre-feature
   * row, non-resume harness, or nothing pinned yet). See migration 0013.
   */
  harnessSessionId: string | null;
  /** better-auth api-key id backing this session's MCP token (null = none yet) */
  apiKeyId: string | null;
}

/**
 * Insert shape: DB defaults fill createdAt/endedAt/status and the liveness /
 * auto-restart columns (alive, backoffCount, restartOnExit) when omitted.
 */
export type NewSession = Omit<
  SessionTable,
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
> & {
  harnessSessionId?: string | null;
  status?: SessionStatus;
  lastOutputAt?: string | null;
  notes?: string | null;
  nameLocked?: number;
  notify?: number;
  waitingSince?: string | null;
  alive?: number;
  backoffCount?: number;
  restartOnExit?: number;
  exitCode?: number | null;
  startedAt?: string | null;
  nextRestartAt?: string | null;
  apiKeyId?: string | null;
};
export type SessionUpdate = Partial<Omit<SessionTable, "id" | "userId">>;
