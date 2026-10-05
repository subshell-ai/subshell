import type { SshRunLifecycle } from "@internal/subshell-protocol";
import type { SshActorSide } from "./ssh-actor-side.js";

/**
 * Database table schema for SSH structured-command runs (SSH-SUPPORT.md §4,
 * Persistence). The PLANE's record of a run whose output lives on the
 * connecting runtime: the server stores run METADATA and relays bounded
 * reads, never a second unbounded output copy.
 *
 * The row is the durable-dispatch anchor: the ID is server-allocated and also
 * the node's filesystem name, the digest binds the full request (a duplicate
 * delivery returns this row; a different payload under the ID is refused at
 * the node), and the lifecycle plus separate cancellation/deadline facts are
 * the plane's mirror of the node's `SshRunFactsWire`. A crash between node
 * acceptance and spawn reads back `unknown` here too - the plane never
 * re-dispatches a known ID automatically.
 */
export interface SshRunTable {
  /** Server-allocated opaque run id (uuid; also the node's filesystem name, minted to satisfy `isNodeSubshellId`) */
  id: string;
  /** Owning user id (the §3 quota unit: per-owner-per-node active runs) */
  userId: string;
  /**
   * Connecting node id at dispatch. Nullable AFTER THE FACT: deleting a node
   * sets it null (SET NULL) while the retained history keeps its facts;
   * dispatch always happens with a resolved non-null node.
   */
  nodeId: string | null;
  /**
   * Source connection id; NULL after the connection is deleted (SET NULL).
   * History must outlive the connection (spec §4's immutable-destination
   * rule), which is exactly why the snapshot is copied below rather than
   * joined.
   */
  connectionId: string | null;
  /** Connection revision this run was authorized against */
  connectionRevision: number;
  /** JSON text of the destination snapshot used for this run (immutable copy, survives connection deletion and later revisions) */
  configSnapshot: string;
  /**
   * Who initiated: a human at a cookie session or a granted pane's token.
   * This is the row-level "who to cancel on revocation" fact - a grant's
   * revocation cancels the runs ITS credential initiated, never a human's or
   * another grant's.
   */
  initiatedBy: SshActorSide;
  /** Grant row that authorized an AGENT-initiated run; null for human-initiated runs */
  grantId: string | null;
  /**
   * The initiating credential's api-key identity (the pane's key at dispatch
   * time for agent runs; the acting session's minted key is not stored for
   * humans). Revocation matches on THIS, not merely on `grantId`, so a
   * rotated pane cannot have its old runs cancelled by a new credential's
   * revocation.
   */
  apiKeyId: string | null;
  /** The remote command as dispatched. Plaintext at rest like pane logs (same decided sensitivity); NEVER copied into operational logs, audit metadata, or notifications. */
  command: string;
  /** Absolute remote directory used; null = destination login default */
  remoteDir: string | null;
  /** Lowercase-hex sha256 over the complete request payload - the node's dedup second half rides here too (reconcile re-sends the same digest) */
  requestDigest: string;
  /** Requested execution deadline in ms (§3 row 1's caller choice; clamped at dispatch) */
  deadlineMs: number;
  /** Lifecycle mirror of the node's answer; `unknown` is honest, not failed/succeeded (spec §3) */
  status: SshRunLifecycle;
  /** 1 = cancellation requested through this plane (pending dispatch while the node is offline) */
  cancelRequested: number;
  /** 1 = the node confirmed LOCAL supervised processes stopped; remote descendants are never confirmed */
  cancelLocalConfirmed: number;
  /** 1 = the execution deadline fired */
  deadlineHit: number;
  /** Observed remote exit status; null unless `status` is `completed` with an observation */
  remoteStatus: number | null;
  /**
   * 1 = `remote_status` is a CONFIRMED remote program status. 0 whenever it
   * is null, whenever it is 255 without corroborating transport facts, or
   * whenever the node answered `unknown` - OpenSSH's 255 is ambiguous
   * (man.openbsd.org/ssh#EXIT_STATUS) and this column is where the contract
   * says so.
   */
  remoteStatusConfirmed: number;
  /** Local ssh child's exit code (null if signalled or never seen) */
  localExitCode: number | null;
  /** Signal name that killed the local ssh child; null unless it was signalled */
  localExitSignal: string | null;
  /** ISO 8601 acceptance row created (dispatch requested) */
  createdAt: string;
  /** ISO 8601 first observation of `running` (null until then) */
  startedAt: string | null;
  /** ISO 8601 terminal observation (`completed`/`unknown` reached); retention sweeps compare against this */
  finishedAt: string | null;
  /** ISO 8601 last fact update (reconcile stamps it even when only observation order changed) */
  updatedAt: string;
}

/** Insert shape: DB defaults fill `createdAt`/`updatedAt`; the lifecycle facts start at their zero values. */
export type NewSshRun = Omit<SshRunTable, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string };

/** Update shape: the mirror columns - identity, digest, and dispatch-time copies stay fixed. */
export type SshRunUpdate = Partial<
  Omit<
    SshRunTable,
    | "id"
    | "userId"
    | "nodeId"
    | "connectionId"
    | "connectionRevision"
    | "configSnapshot"
    | "initiatedBy"
    | "grantId"
    | "apiKeyId"
    | "command"
    | "remoteDir"
    | "requestDigest"
    | "deadlineMs"
    | "createdAt"
  >
>;
