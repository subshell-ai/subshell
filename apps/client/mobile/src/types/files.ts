/**
 * Hand-written mirrors of `GET /api/files/explore` — moved out of
 * `types/profile.ts` when presets replaced profiles (spec 2026-09-13); the
 * folder picker has never had anything to do with either.
 */

/** One entry from `GET /api/files/explore` — one level per request by design. */
export interface ExploreEntry {
  /** File/dir name (dotfiles hidden server-side) */
  name: string;
  /** Absolute path */
  path: string;
  /** Only two kinds ever ship; anything else is filtered server-side */
  kind: "dir" | "file";
}

/** Response of `GET /api/files/explore` — favourites + recents ride along (spec: one request per folder). */
export interface ExploreResult {
  /** Resolved directory */
  path: string;
  /** Parent dir, null at the filesystem root */
  parent: string | null;
  /** Directory entries, one level deep */
  entries: ExploreEntry[];
  /** Recently used working directories, newest first (favourites win) */
  recent: { path: string; label: string | null }[];
  /** Starred paths (the picker's favourites section) */
  favorites: { path: string; label: string | null }[];
}
