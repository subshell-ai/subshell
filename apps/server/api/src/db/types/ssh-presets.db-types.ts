/** The four authentication modes an SSH preset can record. Fixed set, so it's a union, not a string. */
export type SshPresetAuthentication = "connecting" | "remote" | "local-key" | "password";

/**
 * A saved SSH connection preset: the connecting node, the canonical resolved
 * destination, the authentication preference, and (for remote keys) the chosen
 * node's public-key fingerprints. It stores NO credential: private keys,
 * passphrases, native approvals and passwords are never persisted here.
 */
export interface SshPresetTable {
  /** Preset id (uuid) */
  id: string;
  /** Owning user; foreign rows read as 404 (docs/security.md §3) */
  userId: string;
  /** Display name, unique per owner under a case-insensitive index */
  name: string;
  /** Optional longer description shown beside the preset */
  description: string | null;
  /**
   * Connecting node id; set null by FK when that node is deleted, which leaves
   * the preset unreadable for launch until the owner picks a node again.
   */
  nodeId: string | null;
  /** Canonical resolved destination (`host:port` / `user@host:port`) */
  destination: string;
  /** Display-only alias from the resolved snapshot; never used to re-resolve */
  alias: string | null;
  /** Original resolution token; the saved destination constrains its current resolution. */
  resolutionAlias: string | null;
  /** How a connection authenticates; none of these four modes stores a secret */
  authentication: SshPresetAuthentication;
  /** Node providing the selected keys for `remote` authentication; null otherwise */
  keyHome: string | null;
  /** JSON-encoded array of selected `SHA256:` public-key fingerprints (remote only); null otherwise */
  fingerprints: string | null;
  /** ISO 8601 creation timestamp (DB default) */
  createdAt: string;
  /** ISO 8601 last-update timestamp */
  updatedAt: string;
}
