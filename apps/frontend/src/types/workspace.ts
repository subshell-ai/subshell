import type { SessionStatus } from "@/types/session";

/**
 * Where a new pane goes relative to a reference pane. Matches dockview's
 * `addPanel` position direction vocabulary — NOT its drop-event position
 * vocabulary (`'top' | 'bottom' | 'left' | 'right' | 'center'`), which
 * `workspace-dock.tsx` translates via dockview-core's own
 * `positionToDirection` before it ever reaches an `onAdd` callback.
 */
export type SplitDirection = "left" | "right" | "above" | "below" | "within";

/** A workspace as returned by the workspaces API. */
export interface WorkspaceRow {
  /** Workspace id */
  id: string;
  /** Name, unique per user */
  name: string;
  /** Saved dockview layout tree, or null when none has been saved yet */
  layout: unknown | null;
  /** Number of sessions (panes) the workspace currently holds */
  sessionCount: number;
  /** Created timestamp (ISO 8601) */
  createdAt: string;
  /** Updated timestamp (ISO 8601) */
  updatedAt: string;
}

/** One pane in a workspace's tiling layout, with its session's summary joined in. */
export interface WorkspacePaneRow {
  /** Pane id */
  id: string;
  /** Session rendered in this pane */
  sessionId: string;
  /** Session display name, for the pane title */
  sessionName: string;
  /** Lifecycle status of the session */
  sessionStatus: SessionStatus;
  /** False once the harness process has exited */
  sessionAlive: boolean;
  /** Exit code of the pane's session once dead; null while alive or unreadable */
  sessionExitCode: number | null;
  /**
   * ISO ts of the attention event that put this session in waiting-for-you
   * state; null when not waiting. Drives the dock tab's waiting marker.
   */
  sessionWaitingSince: string | null;
  /** Absolute working directory of the session */
  workingDir: string;
}

/** A workspace plus its panes, as returned by `GET /api/workspaces/:id`. */
export interface WorkspaceDetail {
  /** The workspace itself */
  workspace: WorkspaceRow;
  /** Panes in its tiling layout */
  panes: WorkspacePaneRow[];
}
