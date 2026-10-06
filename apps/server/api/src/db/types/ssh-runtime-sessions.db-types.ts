/** Session lifecycle (design 2026-10-05 §4). The live broker decides it; the row records it. */
export type SshRuntimeSessionStatus = "opening" | "active" | "lost" | "closed";
/** Runtime list of {@link SshRuntimeSessionStatus}. */
export const SSH_RUNTIME_SESSION_STATUSES: readonly SshRuntimeSessionStatus[] = ["opening", "active", "lost", "closed"];

/**
 * Database table schema for `ssh_runtime_sessions` (migration 0049): one row
 * per brokered destination session. The row is the SESSION record and the
 * history (`lost`/`closed` rows outlive their sessions); the in-memory
 * registry in `services/ssh-runtime/session-registry.ts` holds the live byte
 * channel, and the two are reconciled at every transition (the registry is
 * authority for "is this session open NOW", the row for everything else).
 *
 * `user` is the destination account or null (the connecting account's own
 * default); identity files, config contents and key material never enter this
 * shape (design §8 - the snapshot grammar's path-only rule, applied again).
 */
export interface SshRuntimeSessionTable {
  /** Session id - the plane-minted broker ref (uuid; the `ref` on every session frame) */
  id: string;
  /** Who opened the session; every pane through it belongs to this user (design §4) */
  ownerUserId: string;
  /**
   * The ENROLLED node that brokered the SSH child; opening required real
   * ownership of it. NULLABLE by design (migration 0049): node ids are plain
   * text refs by design here, and deleting the connecting machine SET NULLs
   * this so the history outlives the machine.
   */
  connectingNodeId: string | null;
  /** The hidden `nodes` row (kind 'runtime') the session's panes carry as node_id */
  runtimeNodeId: string;
  /** The config token the human chose (display/review context) */
  alias: string;
  /** Reviewed destination host */
  host: string;
  /** Reviewed destination port */
  port: number;
  /** Destination account, or null for the connecting account's default */
  user: string | null;
  /** {@link SshRuntimeSessionStatus}; `opening` until the hello answers */
  status: SshRuntimeSessionStatus;
  /** Parsed runtime hello JSON (version, os, arch, tmuxSocket, dataDir, paneCount); null until `active` */
  helloJson: string | null;
  /** ISO 8601 open requested */
  createdAt: string;
  /** ISO 8601 of the last frame that proved the child alive (honest "last heard", not a heartbeat) */
  lastSeenAt: string | null;
  /** ISO 8601 of the terminal transition (lost or closed) */
  closedAt: string | null;
}

/**
 * Insert payload for a fresh `opening` session. `connectingNodeId` is
 * required HERE (the broker row must exist to open; the column's nullability
 * is about the node's later deletion, not about the insert).
 */
export type NewSshRuntimeSession = Pick<
  SshRuntimeSessionTable,
  "id" | "ownerUserId" | "runtimeNodeId" | "alias" | "host" | "port" | "user"
> & { connectingNodeId: string } & Partial<Pick<SshRuntimeSessionTable, "status" | "helloJson" | "createdAt">>;
