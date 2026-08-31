/**
 * One pane in a workspace's tiling layout, holding exactly one session.
 *
 * Both foreign keys cascade on delete, so a pane cannot outlive its workspace
 * or its session.
 */
export interface WorkspacePaneTable {
  /** Unique pane id (uuid) */
  id: string;
  /** Owning workspace (FK, cascades) */
  workspaceId: string;
  /** Session rendered in this pane (FK, cascades) */
  sessionId: string;
  /** ISO 8601 timestamp when the pane was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill the timestamps. */
export type NewWorkspacePane = Omit<WorkspacePaneTable, "createdAt" | "updatedAt">;

/** Update shape. */
export type WorkspacePaneUpdate = Partial<Omit<NewWorkspacePane, "id" | "workspaceId">>;
