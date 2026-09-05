/**
 * Database table schema for a node's directory allowlist (spec 2026-09-05).
 *
 * NO ROWS for a node means UNRESTRICTED, not "deny everything" — the same
 * meaning an unset `SUBSHELL_FS_ROOT` carries, and what keeps every node that
 * predates the feature behaving as before.
 */
export interface NodeAllowedDirTable {
  /** Row id (uuid) */
  id: string;
  /** Node this rule belongs to; cascade-deletes with it */
  nodeId: string;
  /**
   * Absolute directory, already normalized by `normalizeAllowedDirs`
   * (`@internal/subshell-protocol`): no `..`, no trailing slash, no duplicate
   * separators. Storing raw input would make the unique index meaningless and
   * the prefix test unsound.
   */
  path: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

/** Insert shape (the repository supplies id/createdAt). */
export type NewNodeAllowedDir = NodeAllowedDirTable;
