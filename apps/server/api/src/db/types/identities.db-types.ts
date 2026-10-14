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
  /**
   * JSON-serialized JWK (P-256 / ES256 public key): the machine's signing
   * identity for the SSH agent relay (spec 2026-10-08 §4.2). Only `node:`
   * principals ever carry one - enroll fills it and node deletion cascades
   * it exactly as `publicKey` does; a null reads as "never reported" and is
   * what every pre-M2 row and every pane/user holds.
   */
  signingPublicKey: string | null;
  /** Convenience label (e.g. subshell name); not authoritative */
  displayName: string | null;
  /** ISO 8601 timestamp of (re-)registration (DB default); re-registering rotates */
  registeredAt: string;
}
