/**
 * A post in a channel's append-only log. The envelope is a jose General JWE
 * JSON string — the server stores and forwards it without ever parsing its
 * ciphertext. Posts are immutable: no UPDATE/DELETE shapes exist by design.
 */
export interface ChannelPostTable {
  /** Unique post id (uuid) */
  id: string;
  /** Owning channel */
  channelId: string;
  /** Per-channel monotonic sequence number (the read cursor) */
  seq: number;
  /** Author principal label, derived from the caller's token — never self-declared */
  author: string;
  /** General JWE JSON (opaque to the server) */
  envelope: string;
  /** ISO 8601 creation timestamp (DB default) */
  createdAt: string;
}

/**
 * Denormalized recipient list of a post, so a reader's fetch can join-filter
 * to exactly the posts they can decrypt (portably, no SQLite JSON SQL).
 */
export interface ChannelPostRecipientTable {
  /** The post this row belongs to */
  postId: string;
  /** A recipient principal label */
  principalId: string;
}
