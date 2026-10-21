/** One saved path in the picker's Recent or Favorites section. */
export interface SavedPath {
  /** Absolute directory path. */
  path: string;
  /** Operator-chosen label, or null. */
  label: string | null;
}

/** One entry in a directory listing. */
export interface DirEntry {
  /** Base name, as it appears in the listing. */
  name: string;
  /** Absolute path — what a click selects and browses into. */
  path: string;
  /** Directories are the only rows the picker renders; files are listed but filtered out there. */
  kind: "dir" | "file";
}

/** One level of the server-side folder picker (`GET /api/files/explore`). */
export interface ExploreResult {
  /** The directory that was listed, resolved. */
  path: string;
  /** Its parent, or null at the filesystem root. */
  parent: string | null;
  /** Direct children; empty when the folder is empty OR when `blocked` is set.
   *  On a LOCAL browse this is one page of the sorted listing; follow
   *  `nextCursor` for the rest. A remote browse is never paged. */
  entries: DirEntry[];
  /**
   * Opaque cursor naming the next page of `entries`; pass it back verbatim as
   * the `cursor` query param. Absent once the listing is exhausted (the final
   * page, a blocked read, or any remote browse; the agent caps that one
   * instead, see `truncated`).
   */
  nextCursor?: string;
  /**
   * True only on a remote (node) browse whose listing hit the agent's
   * 1,000-entry cap, so the picker can say so rather than pass the partial
   * list off as everything. The key is absent on a complete listing and on
   * every local browse.
   */
  truncated?: boolean;
  /** Three most recently used paths, favorites excluded. */
  recent: SavedPath[];
  /** Starred paths, newest first. */
  favorites: SavedPath[];
  /**
   * Present when the directory could not be listed though the request
   * succeeded — the reason `entries` is empty. `"permission"`: the OS refused
   * the read (macOS asks per protected folder and a decline throws forever
   * after; unix modes reach the same place). `"timeout"`: the read never
   * answered within the server's deadline (a hung network/automount — the
   * instance-wedging case) and may well work later.
   *
   * An empty listing WITHOUT the flag is a folder that genuinely holds nothing.
   * The flag is never on a child: probing each one is the act that fires a
   * prompt per folder.
   */
  blocked?: "permission" | "timeout";
}
