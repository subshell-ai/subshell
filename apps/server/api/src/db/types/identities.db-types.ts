/**
 * A principal's encryption identity: the P-256 public key used for sealed
 * delivery. Deliberately separate from subshells so users (and, later, remote
 * peers) hold identities with the same shape.
 */
export interface IdentityTable {
  /** Principal label ("sess:<id>" | "user:<id>" | future "peer:...") */
  principalId: string;
  /** JSON-serialized JWK (P-256 / ECDH-ES public key) */
  publicKey: string;
  /** Convenience label (e.g. subshell name); not authoritative */
  displayName: string | null;
  /** ISO 8601 timestamp of (re-)registration (DB default); re-registering rotates */
  registeredAt: string;
}
