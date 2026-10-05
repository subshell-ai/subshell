/**
 * Database table schema for saved SSH connections (SSH-SUPPORT.md §4,
 * Persistence). A CONNECTION, not an enrolled node: it binds an owner and a
 * connecting node to an approved normalized snapshot.
 *
 * The snapshot is stored as JSON TEXT of `SshConnectionSnapshotWire`; nothing
 * in this table (or its descendants) ever holds credential CONTENTS - the
 * snapshot's `identityFiles`/`certificateFiles`/`authAgentSocket` are PATHS on
 * the connecting node, whose bytes stay under that OS account (the §1
 * decision: reuse credentials on the connecting node, no credential storage).
 */
export interface SshConnectionTable {
  /** Unique connection id (uuid) */
  id: string;
  /** Owning user id; the config gate and grants are owner-only (admin status does NOT reach another user's private connection) */
  userId: string;
  /** Connecting node id ('local' = the server's built-in node); an admin may configure `local` rows subject to launch/maintenance rules */
  nodeId: string;
  /** Human display label ("Staging"); normalized and capped by the service like every other label */
  displayName: string;
  /** JSON text of the approved `SshConnectionSnapshotWire` AT THIS REVISION; never raw config file contents */
  configSnapshot: string;
  /** Optional absolute REMOTE directory default (distinct spelling from any connecting-node path, per §3's route display); null = destination login default */
  remoteDir: string | null;
  /**
   * Revision counter starting at 1. An EDIT creates a new revision (the
   * service re-resolves and re-validates the snapshot); every grant, run and
   * managed pane pins the revision it was made against, so a config edit
   * invalidates grants by revision mismatch rather than by cascade (spec §2).
   */
  revision: number;
  /** ISO 8601 creation timestamp (DB default) */
  createdAt: string;
  /** ISO 8601 timestamp of the last revision-bearing update */
  updatedAt: string;
}

/** Insert shape: DB defaults fill `revision` (1) and both timestamps. */
export type NewSshConnection = Omit<SshConnectionTable, "revision" | "createdAt" | "updatedAt"> & {
  revision?: number;
};

/** Update shape: any stored column but the identity ones (owner and node are fixed for life). */
export type SshConnectionUpdate = Partial<Omit<SshConnectionTable, "id" | "userId" | "nodeId" | "createdAt">>;
