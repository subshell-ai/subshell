/**
 * Database table schema for single-use node enrollment keys (spec §5.1).
 *
 * Since the node-setup revamp (2026-09-17) the row holds the `nsk_…` code
 * ITSELF, because the Setup keys page shows it — a digest could not be
 * rendered. That is a bounded exposure, not an oversight: the value enrolls
 * ONE machine, redeems ONCE (`usedAt`), and dies after 24 h (`expiresAt`), in a
 * database an owner can already read to mint another. `docs/security.md`,
 * "Setup keys are stored in plaintext", carries the accounting.
 */
export interface NodeSetupKeyTable {
  /** Unique id (uuid) */
  id: string;
  /** User who created the key (also the future node owner) */
  ownerUserId: string;
  /**
   * The `nsk_…` code, in the clear — the form redemption compares against and
   * the form the Setup keys page lists. Worthless once `usedAt` is set or
   * `expiresAt` has passed.
   */
  key: string;
  /** ISO 8601 creation time */
  createdAt: string;
  /** ISO 8601 expiry (default 24h out) */
  expiresAt: string;
  /** ISO 8601 when consumed; null while unused */
  usedAt: string | null;
  /** Node created by consuming this key */
  consumedNodeId: string | null;
}
