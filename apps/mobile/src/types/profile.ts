/** One harness profile as `GET /api/profiles` returns it (mirror of ProfileSchema; only the fields this app renders). */
export interface ProfileView {
  /** Profile id (uuid) — the create-session body keys on it */
  id: string;
  /** Owning user id */
  userId: string;
  /** Harness plugin id, e.g. `claude-code` */
  harnessId: string;
  /** Display name */
  name: string;
  /** Longer description (nullable) */
  description: string | null;
  /** 1 = auto-seeded default profile (cannot be deleted) */
  isDefault: number;
  /** 1 = new sessions auto-restart on exit */
  restartOnExit: number;
}

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
