/**
 * A workspace: a named set of references to subshells with a saved tiling
 * layout, private to one user. It exists exactly as long as it holds a tab —
 * the service retires it the moment its last pane is removed (spec 2026-10-17).
 */
export interface WorkspaceTable {
  /** Unique workspace id (uuid) */
  id: string;
  /** Owning user id; every query filters on this */
  userId: string;
  /**
   * Friendly label. NOT unique: auto-created workspaces reuse their default
   * title freely, and every lookup is by id (the 0058 migration retired the
   * old `(user_id, name)` unique index along with the draft machinery).
   */
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
