/**
 * Hand-written mirror of `GET /api/admin/updates` and its nested
 * `GET /api/admin/server/update` (spec 2026-09-15 §4.5, §4.6).
 *
 * Hand-written like every other file in `src/types/`, because the SPA reads
 * these through `apiFetch` rather than through Eden Treaty: one shape stated
 * here, checked against the route's `t` schema by review, is what the table
 * and hooks share.
 */

/** One published release, as every row names it. */
export interface ReleaseRef {
  /** Strict `X.Y.Z`, off the tag. */
  version: string;
  /** The git tag the release carries (`cli-server-v0.7.0`) — also what a link to the release page needs. */
  tag: string;
  /** ISO 8601 from the release source, or null when it did not say. */
  publishedAt: string | null;
}

/** Which step of a running update the server is on. `failed` is terminal. */
export type UpdateJobPhase = "downloading" | "verifying" | "backing-up" | "swapping" | "restarting" | "failed";

/** The in-process update job, polled at 1 s while one runs. */
export interface UpdateJob {
  /** The version the server was when the job started. */
  from: string;
  /** The version being installed. */
  to: string;
  /** ISO 8601, when the job started. */
  startedAt: string;
  /** Which step is running now. */
  phase: UpdateJobPhase;
  /** Bytes downloaded so far; only moves while `phase` is `downloading`. */
  received: number;
  /** Total bytes, when the release source sent a content length. */
  total: number | null;
  /** Why the job stopped, when `phase` is `failed`. */
  error: string | null;
}

/** The transaction that reverted at the server's last boot. */
export interface FailedUpdate {
  /** The version restored by the revert. */
  from: string;
  /** The version that could not boot. */
  to: string;
  /** The installed binary's path. */
  binary: string;
  /** Where the previous binary was kept while the swap stood. */
  previousBinary: string;
  /** The snapshot taken before the swap, or null when there was none. */
  backup: string | null;
  /** ISO 8601, when the swap began. */
  startedAt: string;
  /** Which surface drove the update. */
  origin: "cli" | "api" | "desktop";
  /** Whether the pane-safety refusal was overridden. */
  forced?: boolean;
  /** The migration (or boot) error, flattened to a string. */
  error: string;
  /** ISO 8601, when the revert ran. */
  failedAt: string;
}

/** One database snapshot on disk. */
export interface BackupFile {
  path: string;
  bytes: number;
  /** ISO 8601 of the file's mtime — when it was written. */
  at: string;
}

/** `GET /api/admin/server/update` — can this server replace itself, and with what. */
export interface ServerUpdateView {
  /** Where releases are read from; `enabled` false is the air-gapped instance. */
  source: { url: string | null; enabled: boolean };
  /** The version the server is now. */
  current: string;
  /** The newest published server release, or null. */
  latest: ReleaseRef | null;
  /** Why `latest` is null while the source is ON; null when the source answered, or is off. */
  latestError: string | null;
  /** Whether `latest` is newer than `current`. */
  updateAvailable: boolean;
  /**
   * Whether the button is live, and every HARD blocker when it is not. The
   * forcible pane-safety refusal is deliberately NOT here — see `paneSafety`.
   */
  canApply: { ok: boolean; reasons: string[] };
  /** Which file an update would replace. */
  binary: { kind: "compiled" | "source" | "unknown"; path: string | null; reason: string | null };
  /** Whether the restart at the end of an update keeps live panes. */
  paneSafety: "keeps" | "kills" | "unknown";
  /** The running (or last failed) job in the server's current process. */
  job: UpdateJob | null;
  /** The last update that reverted at boot. */
  lastFailure: FailedUpdate | null;
  /** Where snapshots go, how many are kept, and what is there. */
  backups: { dir: string; keep: number; count: number; latest: BackupFile | null };
}

/** Why a stale agent is being kept connected for exactly one command. */
export type HeldReason = "below-floor" | "protocol-mismatch";

/** One enrolled agent node, as the Nodes rows render it. */
export interface NodeUpdateRow {
  id: string;
  /** The node's display name. */
  name: string;
  /** Last-known subshell version, or null before the first ready. */
  agentVersion: string | null;
  /** The release triple for this machine, or null when nothing is published for its platform. */
  target: string | null;
  /** The node protocol this agent speaks; reads against `NodeUpdates.protocol`. */
  protocolVersion: number | null;
  /** Whether the agent holds a live socket right now. */
  online: boolean;
  /** Set when the agent was refused but is kept connected so it can be updated. */
  held: { reason: HeldReason } | null;
  /** Whether the offered node release is newer than this agent's version. */
  updateAvailable: boolean;
  /** Whether this row's Update button is live, and why not. */
  canUpdate: { ok: boolean; reason: string | null };
}

/** The fleet section of the page. */
export interface NodeUpdates {
  /** The newest node release this server can talk to, or null. */
  release: ReleaseRef | null;
  /** Why no node release can be offered; null when one can. */
  reason: string | null;
  /** The oldest agent version this server accepts — half of a held row's sentence. */
  minAgentVersion: string;
  /** The node protocol this server speaks — the other half. */
  protocol: number;
  /** Every enrolled agent node; `local` is never here. */
  rows: NodeUpdateRow[];
}

/** `GET /api/admin/updates` — everything the page renders, in one read. */
export interface UpdatesView {
  server: ServerUpdateView;
  nodes: NodeUpdates;
  desktop: { server: ReleaseRef | null; client: ReleaseRef | null };
}
