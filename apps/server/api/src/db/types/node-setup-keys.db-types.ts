/**
 * Database table schema for single-use node enrollment keys (spec §5.1).
 * The plaintext `nsk_…` code exists only in the create response and the
 * install command; only its SHA-256 hex digest is stored.
 */
export interface NodeSetupKeyTable {
  /** Unique id (uuid) */
  id: string;
  /** User who created the key (also the future node owner) */
  ownerUserId: string;
  /** Human label ("mac mini") */
  label: string;
  /** SHA-256 hex of the plaintext key — never the key itself */
  keyHash: string;
  /** ISO 8601 creation time */
  createdAt: string;
  /** ISO 8601 expiry (default 24h out) */
  expiresAt: string;
  /** ISO 8601 when consumed; null while unused */
  usedAt: string | null;
  /** Node created by consuming this key */
  consumedNodeId: string | null;
}
