/**
 * Shared subshell view model (mirrors the backend toSubshellView shape).
 */

/** Coarse activity heuristic: "active" | "idle" | "terminated". */
export type SubshellActivity = "active" | "idle" | "terminated";

/** Subshell status as exposed by the API. */
export type SubshellStatus = "running" | "terminated";

/**
 * The caller's effective access to a subshell (viewer-relative, spec
 * 2026-08-31 §4). A returned subshell is always visible to *someone*, so this is
 * never "none". `view` = read/watch; `edit` = interact + manage; `owner` = full
 * control (delete, sharing, the notification bell).
 */
export type SubshellAccess = "owner" | "edit" | "view";

/**
 * A subshell as seen by the operator UX (home cards + terminal page).
 */
export interface SubshellView {
  /** Unique identifier (UUID) */
  id: string;
  /** Preset the subshell launched from; null = a presetless launch */
  presetId: string | null;
  /** Harness the subshell runs on (e.g. claude/agent) */
  harnessId: string;
  /**
   * Node the subshell runs on ("local" = control-plane host). The backend now
   * always sends it; optional so older cached payloads keep typechecking
   * (same tolerance as `preview` below).
   */
  nodeId?: string;
  /**
   * True = the subshell's agent node currently has no live connection (spec
   * §5.6) — the subshell may still be RUNNING there, its state is just
   * unobservable from here. Always false for subshells on `local`.
   */
  nodeOffline: boolean;
  /** User-visible subshell name */
  name: string;
  /** True = the operator named/pinned it; false = the pane-title sweep owns it */
  nameLocked: boolean;
  /** Absolute working directory the subshell runs in */
  workingDir: string;
  /** Lifecycle status of the subshell */
  status: SubshellStatus;
  /** ISO 8601 timestamp when the subshell was created */
  createdAt: string;
  /** ISO 8601 timestamp when the subshell ended (null while running) */
  endedAt: string | null;
  /** ISO 8601 timestamp of the last bytes written to the subshell log (null = none yet) */
  lastOutputAt: string | null;
  /** Rough activity state computed from lastOutputAt + status */
  activity: SubshellActivity;
  /** Recent output preview lines (only populated for running subshells; treat as optional here so the client tolerates older backends) */
  preview?: string[];
  /** True while the harness process is alive (false = exited/paused, possibly awaiting a backoff restart) */
  alive: boolean;
  /** Harness exit status (null while running or when the process never exits cleanly) */
  exitCode: number | null;
  /** ISO 8601 timestamp of the most recent process start (null = never started) */
  startedAt: string | null;
  /** Consecutive auto-restarts so far (feeds the backoff schedule) */
  backoffCount: number;
  /** True = the subshell auto-restarts when the process exits */
  restartOnExit: boolean;
  /** ISO 8601 timestamp when the next backoff restart is due (null = none scheduled) */
  nextRestartAt: string | null;
  /** True = pushes (and waiting-for-you priority) enabled for this subshell; false = muted bell */
  notify: boolean;
  /** ISO 8601 ts of the attention event that put the subshell in waiting-for-you state; null = not waiting */
  waitingSince: string | null;
  /** The caller's effective access to this subshell (viewer-relative; drives which controls render) */
  access: SubshellAccess;
  /**
   * How many sharing grants this subshell carries; 0 = private to its owner.
   * Optional for the same reason `nodeId` is — a payload cached by a client
   * older than the field must keep typechecking. Drives the disclosure notice
   * in `lib/trust-notices.ts`: every grantee reads the pane's full output.
   */
  shareCount?: number;
  /** True when one of those grants is the Everyone grant (an uncountable audience). */
  sharedWithEveryone?: boolean;
}
