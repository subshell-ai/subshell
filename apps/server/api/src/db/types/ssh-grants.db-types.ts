/**
 * Storage types for the grant tier (spec 2026-10-08 §6, §9; migration 0050).
 * Three records: the standing authorization (`ssh_key_grants`), the durable
 * first-use approval queue (`ssh_grant_requests`), and the M2 TOFU host-key
 * store (`ssh_host_pins`, schema here per the plan's file map; its read/write
 * logic is T12's).
 */

/** How a grant came to exist; the runtime census is {@link SSH_GRANT_CREATED_VIA}. */
export type SshGrantCreatedVia = "first-use" | "manual";

/**
 * The two doors a grant row arrives through (spec §6.2: "Creation via the
 * screen and via first use write the same row and the same audit event", the
 * `via` field tells them apart after the fact). `first-use` is the standing
 * grant an APPROVED request writes; `manual` is the grants screen.
 */
export const SSH_GRANT_CREATED_VIA: readonly SshGrantCreatedVia[] = ["first-use", "manual"];

/**
 * Lifecycle of a first-use approval request; the runtime census is
 * {@link SSH_GRANT_REQUEST_STATUSES}. `pending` is the only OPEN state:
 * `approved` wrote a grant, `denied` wrote an audit row only, and `expired`
 * was swept at the deadline and wrote NOTHING (spec §6.2). A terminal row
 * stays in the table - the queue is small and the trail is the answer.
 */
export type SshGrantRequestStatus = "pending" | "approved" | "denied" | "expired";

/** Every grant-request status the schema can hold (validation and sweeps iterate this). */
export const SSH_GRANT_REQUEST_STATUSES: readonly SshGrantRequestStatus[] = [
  "pending",
  "approved",
  "denied",
  "expired",
];

/**
 * A standing key grant (spec §6.1): to reach destinations matching the
 * selector, sign with the agent on the key-home machine, using exactly the
 * selected public identities. No secret and no key bytes live here - the
 * fingerprints are OpenSSH `SHA256:` display identifiers over the agent wire
 * encoding (public by nature): spec 2026-10-08 §10 makes the grant's
 * approve/create audit rows NAME the chosen values (the durable selection
 * record), while they enter no other audit row, no notification body, and no
 * log line (docs/security.md §10).
 */
export interface SshKeyGrantTable {
  /** Unique row id (uuid) */
  id: string;
  /** Owning user id (FK to users, ON DELETE CASCADE) - the account whose launches this authorizes */
  ownerUserId: string;
  /** Display name the operator gave the grant (normalized, <= 120 chars at the route) */
  name: string;
  /** Machine A: the key home whose ssh-agent signs (no FK - a vanished node is refused at the gate) */
  keyHomeNodeId: string;
  /**
   * The destination selector, STORED RESOLVED (spec §6.1: an alias typed at
   * approval is resolved to the concrete hostname and the alias kept only as
   * display metadata elsewhere). A concrete hostname or a hostname pattern
   * with `*` wildcards, lowercase, matched against the resolved destination
   * hostname at launch; no whitespace, no control characters.
   */
  resolvedSelector: string;
  /** JSON array of `SHA256:` fingerprint strings (<= SSH_MAX_GRANT_FINGERPRINTS; empty is representable and serves nothing) */
  fingerprints: string;
  /** Which door created the row; see {@link SshGrantCreatedVia} */
  createdVia: SshGrantCreatedVia;
  /** ISO 8601 creation stamp (the match tie-break: oldest grant wins) */
  createdAt: string;
  /** ISO 8601 of the last operator edit (name/selector) */
  updatedAt: string;
}

/**
 * A durable first-use approval request (spec §6.2): recorded BEFORE B's launch
 * fails fast, so a plane restart does not forget outstanding approvals and a
 * re-launch simply finds the standing pending row. The row is the fact that a
 * human must answer it; the audit `node.ssh_grant.request` is the trail.
 */
export interface SshGrantRequestTable {
  /** Unique row id (uuid) - the opaque `requestRef` the refusal and the notification name */
  id: string;
  /** Owning user id (FK to users, ON DELETE CASCADE): the key home's owner, the one whose approval is asked */
  ownerUserId: string;
  /** Machine A asked to sign (no FK; the approvals gate re-reads the row) */
  keyHomeNodeId: string;
  /** The resolved destination hostname the launch would have dialed (stored resolved, like the grant) */
  resolvedSelector: string;
  /**
   * The FULL canonical destination `user@host:port` the asking launch dialed
   * (the `sshCanonicalDestination` spelling, migration 0051). The selector
   * above is hostname-scoped (the grant's match key); the host-key PIN is
   * keyed per this triple, and the approval that creates the grant captures
   * the pin at exactly what was dialed - which requires the row to outlive
   * the launch carrying it. NULL only on a row written before 0051 (the
   * asking launch is gone, nothing to back-fill); approval refuses such a
   * row by name rather than guess a port or a user.
   */
  destination: string | null;
  /** JSON array of pre-selected `SHA256:` fingerprints, or null when none rode the request (the approver picks) */
  requestedFingerprints: string | null;
  /** B's pane (subshell id) whose launch asked - what the approvals screen names as the requester */
  paneId: string;
  /** B's node id: the connecting machine of the asking launch */
  bNodeId: string;
  /** ISO 8601 deadline (setup-key scale, 24 h); the sweep marks a passed row `expired` and writes no audit */
  expiresAt: string;
  /** Lifecycle state; see {@link SshGrantRequestStatus} - only `pending` is answerable */
  status: SshGrantRequestStatus;
  /** ISO 8601 creation stamp */
  createdAt: string;
}

/**
 * One TOFU host-key pin for one owner's resolved destination (spec §9): the
 * `user@host:port` -> pinned public host key + timestamps record the M2 relay
 * path validates against. Per-owner scoping is deliberate: a global pin would
 * let another account's first connection poison (or DoS-lock) a destination
 * this owner never touched. The capture/verification LOGIC is T12; this is
 * the storage shape it must not re-cut.
 */
export interface SshHostPinTable {
  /** Unique row id (uuid) */
  id: string;
  /** Owning user id (FK to users, ON DELETE CASCADE) */
  ownerUserId: string;
  /** Canonical resolved destination `user@host:port` (the `sshCanonicalDestination` spelling) */
  destination: string;
  /**
   * The pinned public host-key entry, one OpenSSH `known_hosts` line: the
   * destination's pattern, the key type, and the base64 key material (plus
   * any comment A's own file carried) - stored VERBATIM from A's recorded
   * trust so B's file carries exactly the bytes A matched, never a
   * reconstruction that re-spells A's entry. Public material end to end
   * (a known_hosts entry CHECKS a server, it is not a secret); the audit
   * rows name the destination and this line's `SHA256:` fingerprint, never
   * the bytes themselves.
   */
  hostKey: string;
  /** ISO 8601 first capture (the TOFU moment) */
  createdAt: string;
  /** ISO 8601 of the last accepted match (a differing key never writes it - that is the §9 hard block) */
  updatedAt: string;
}
