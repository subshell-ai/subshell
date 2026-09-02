/**
 * Shared session view model (mirrors the backend toSessionView shape).
 */

/** Coarse activity heuristic: "active" | "idle" | "terminated". */
export type SessionActivity = "active" | "idle" | "terminated";

/** Session status as exposed by the API. */
export type SessionStatus = "running" | "terminated";

/**
 * The caller's effective access to a session (viewer-relative, spec
 * 2026-08-31 §4). A returned session is always visible to *someone*, so this is
 * never "none". `view` = read/watch; `edit` = interact + manage; `owner` = full
 * control (delete, sharing, the notification bell).
 */
export type SessionAccess = "owner" | "edit" | "view";

/**
 * A session as seen by the operator UX (home cards + terminal page).
 */
export interface SessionView {
  /** Unique identifier (UUID) */
  id: string;
  /** Profile the session was started from */
  profileId: string;
  /** Harness the session runs on (e.g. claude/agent) */
  harnessId: string;
  /**
   * Node the session runs on ("local" = control-plane host). The backend now
   * always sends it; optional so older cached payloads keep typechecking
   * (same tolerance as `preview` below).
   */
  nodeId?: string;
  /**
   * True = the session's agent node currently has no live connection (spec
   * §5.6) — the session may still be RUNNING there, its state is just
   * unobservable from here. Always false for sessions on `local`.
   */
  nodeOffline: boolean;
  /** User-visible session name */
  name: string;
  /** True = the operator named/pinned it; false = the pane-title sweep owns it */
  nameLocked: boolean;
  /** Absolute working directory the session runs in */
  workingDir: string;
  /** Lifecycle status of the session */
  status: SessionStatus;
  /** ISO 8601 timestamp when the session was created */
  createdAt: string;
  /** ISO 8601 timestamp when the session ended (null while running) */
  endedAt: string | null;
  /** ISO 8601 timestamp of the last bytes written to the session log (null = none yet) */
  lastOutputAt: string | null;
  /** Free-text operator note (null = none) */
  notes: string | null;
  /** Rough activity state computed from lastOutputAt + status */
  activity: SessionActivity;
  /** Recent output preview lines (only populated for running sessions; treat as optional here so the client tolerates older backends) */
  preview?: string[];
  /** True while the harness process is alive (false = exited/paused, possibly awaiting a backoff restart) */
  alive: boolean;
  /** Harness exit status (null while running or when the process never exits cleanly) */
  exitCode: number | null;
  /** ISO 8601 timestamp of the most recent process start (null = never started) */
  startedAt: string | null;
  /** Consecutive auto-restarts so far (feeds the backoff schedule) */
  backoffCount: number;
  /** True = the session auto-restarts when the process exits */
  restartOnExit: boolean;
  /** ISO 8601 timestamp when the next backoff restart is due (null = none scheduled) */
  nextRestartAt: string | null;
  /** True = pushes (and waiting-for-you priority) enabled for this session; false = muted bell */
  notify: boolean;
  /** ISO 8601 ts of the attention event that put the session in waiting-for-you state; null = not waiting */
  waitingSince: string | null;
  /** The caller's effective access to this session (viewer-relative; drives which controls render) */
  access: SessionAccess;
  /**
   * Trailing output lines a terminal replays when attaching to this session
   * (1–200); null = the instance default (SUBSHELL_TERMINAL_REPLAY_LINES, 100).
   */
  terminalReplayLines: number | null;
}
