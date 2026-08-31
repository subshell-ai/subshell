/**
 * Database table schema for recently-used working directories.
 * Shown as quick-pick options in the folder picker.
 */
export interface RecentPathTable {
  /** Unique id (uuid) */
  id: string;
  /** Owning user id */
  userId: string;
  /** Absolute path used before */
  path: string;
  /** Optional friendly label (e.g. "mote repo") */
  label: string | null;
  /** Machine the path belongs to (recent paths are per-node) */
  nodeId: string;
  /** ISO 8601 timestamp of the last time this path was used */
  lastUsedAt: string;
}

export type NewRecentPath = Omit<RecentPathTable, "lastUsedAt"> & { lastUsedAt?: string };
