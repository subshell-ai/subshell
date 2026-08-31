/**
 * A workspace: a saved tiling layout of sessions, private to one user.
 */
export interface WorkspaceTable {
  /** Unique workspace id (uuid) */
  id: string;
  /** Owning user id; every query filters on this */
  userId: string;
  /** Friendly label, unique per user */
  name: string;
  /** Serialized dockview layout tree, or null when none has been saved yet */
  layoutJson: string | null;
  /** ISO 8601 timestamp when the workspace was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill the timestamps. */
export type NewWorkspace = Omit<WorkspaceTable, "createdAt" | "updatedAt" | "layoutJson"> & {
  layoutJson?: string | null;
};

/** Update shape. */
export type WorkspaceUpdate = Partial<Omit<NewWorkspace, "id" | "userId">>;
