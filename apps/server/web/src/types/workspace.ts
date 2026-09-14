import type { SubshellStatus } from "@/types/subshell";

/**
 * Where a new pane goes relative to a reference pane. Matches dockview's
 * `addPanel` position direction vocabulary — NOT its drop-event position
 * vocabulary (`'top' | 'bottom' | 'left' | 'right' | 'center'`), which
 * `workspace-dock.tsx` translates via dockview-core's own
 * `positionToDirection` before it ever reaches an `onAdd` callback.
 */
export type SplitDirection = "left" | "right" | "above" | "below" | "within";

/**
 * Every {@link SplitDirection}, for the code that has to validate one — the
 * `dir` search param a split intent arrives in (`lib/workspace-split-intent.ts`)
 * is a string until something checks it against this.
 */
export const SPLIT_DIRECTIONS: readonly SplitDirection[] = ["left", "right", "above", "below", "within"];

/** A workspace as returned by the workspaces API. */
export interface WorkspaceRow {
  /** Workspace id */
  id: string;
  /** Name, unique per user */
  name: string;
  /**
   * True for an UNSAVED workspace — one made by splitting a subshell, which
   * exists on the server (so it is reload-safe and cross-device) but is
   * excluded from `GET /api/workspaces`, and so from the workspaces page and
   * the sidebar's recents. Saving it is `PUT /:id { name, draft: false }`; a
   * saved workspace can never become a draft again.
   */
  draft: boolean;
  /** Saved dockview layout tree, or null when none has been saved yet */
  layout: unknown | null;
  /** Number of subshells (panes) the workspace currently holds */
  subshellCount: number;
  /** Created timestamp (ISO 8601) */
  createdAt: string;
  /** Updated timestamp (ISO 8601) */
  updatedAt: string;
}

/** One pane in a workspace's tiling layout, with its subshell's summary joined in. */
export interface WorkspacePaneRow {
  /** Pane id */
  id: string;
  /** Subshell rendered in this pane */
  subshellId: string;
  /** Subshell display name, for the pane title */
  subshellName: string;
  /** Lifecycle status of the subshell */
  subshellStatus: SubshellStatus;
  /** False once the harness process has exited */
  subshellAlive: boolean;
  /** Exit code of the pane's subshell once dead; null while alive or unreadable */
  subshellExitCode: number | null;
  /**
   * ISO ts of the attention event that put this subshell in waiting-for-you
   * state; null when not waiting. Drives the dock tab's waiting marker.
   */
  subshellWaitingSince: string | null;
  /** Absolute working directory of the subshell */
  workingDir: string;
  /**
   * Node the subshell runs on ("local" = control-plane host). Optional like
   * `SubshellView.nodeId` — older cached payloads keep typechecking.
   */
  subshellNodeId?: string;
  /**
   * True = the subshell's agent node has no live connection (spec §5.6):
   * the pane may still be RUNNING there, its state is just unobservable
   * from here. Always false for subshells on `local`.
   */
  subshellNodeOffline?: boolean;
}

/** A workspace plus its panes, as returned by `GET /api/workspaces/:id`. */
export interface WorkspaceDetail {
  /** The workspace itself */
  workspace: WorkspaceRow;
  /** Panes in its tiling layout */
  panes: WorkspacePaneRow[];
}
