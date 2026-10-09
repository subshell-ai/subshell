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
