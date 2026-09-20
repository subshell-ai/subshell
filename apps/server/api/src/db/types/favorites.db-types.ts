/**
 * What can be favorited. One value today; subshell/workspace kinds land
 * with their own UIs and reuse the same table.
 */
export type FavoriteKind = "directory";

/**
 * Database table schema for per-user favorites.
 *
 * Polymorphic by design: `kind` names the entity type and `ref` addresses
 * one — an absolute path for "directory", an entity id for future kinds.
 * Unique per (user, node, kind, ref).
 */
export interface FavoriteTable {
  /** Unique id (uuid) */
  id: string;
  /** Owning user id */
  userId: string;
  /**
   * The machine `ref` addresses (migration 0034). A path is a claim about ONE
   * filesystem, so `/home/dev/api` starred on Box is Box's row; `local` is
   * the control-plane host and the default, exactly as in `recent_paths`.
   */
  nodeId: string;
  /** Entity type ("directory" today) */
  kind: FavoriteKind;
  /** What is favorited: absolute path for "directory", entity id later */
  ref: string;
  /** Optional friendly label (e.g. "subshell repo") */
  label: string | null;
  /** ISO 8601 timestamp when it was starred */
  createdAt: string;
}

/** Insert shape: DB defaults fill createdAt. */
export type NewFavorite = Omit<FavoriteTable, "createdAt"> & { createdAt?: string };
