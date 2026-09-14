/** One saved path in the picker's Recent or Favorites section. */
export interface SavedPath {
  /** Absolute directory path. */
  path: string;
  /** Operator-chosen label, or null. */
  label: string | null;
}

/** One entry in a directory listing. */
export interface DirEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** One level of the server-side folder picker (`GET /api/files/explore`). */
export interface ExploreResult {
  /** The directory that was listed, resolved. */
  path: string;
  /** Its parent, or null at the filesystem root. */
  parent: string | null;
  /** Direct children — empty when the folder is empty OR when `blocked` is set. */
  entries: DirEntry[];
  /** Three most recently used paths, favorites excluded. */
  recent: SavedPath[];
  /** Starred paths, newest first. */
  favorites: SavedPath[];
  /**
   * Present when the OS refused to list THIS directory — macOS asks per
   * protected folder (Desktop, Documents, Downloads) and a decline makes the
   * read throw forever after; plain unix modes reach the same place.
   *
   * It is why `entries` is empty, and an empty listing without it is a folder
   * that genuinely holds nothing. The flag is never on a child: probing each
   * one is the act that fires a prompt per folder.
   */
  blocked?: "permission";
}
