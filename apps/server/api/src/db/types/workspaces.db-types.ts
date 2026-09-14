/**
 * A workspace: a saved tiling layout of subshells, private to one user.
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
  /**
   * 1 while this is an unsaved draft created by splitting a subshell, 0 once
   * named and saved (SQLite has no boolean, like `alive`). Drafts are hidden
   * from the list endpoint and sit OUTSIDE the unique `(user_id, name)` index —
   * they are auto-named after their root subshell, so collisions are expected.
   * The only transition is 1 → 0; a saved workspace never becomes a draft.
   */
  draft: number;
  /** ISO 8601 timestamp when the workspace was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill the timestamps, and an omitted `draft` means saved. */
export type NewWorkspace = Omit<WorkspaceTable, "createdAt" | "updatedAt" | "layoutJson" | "draft"> & {
  layoutJson?: string | null;
  draft?: number;
};

/** Update shape. */
export type WorkspaceUpdate = Partial<Omit<NewWorkspace, "id" | "userId">>;
