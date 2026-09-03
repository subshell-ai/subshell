/**
 * A named shared channel for cross-subshell communication. Global within the
 * instance: every authenticated principal can list, join, and post.
 */
export interface ChannelTable {
  /** Unique channel id (uuid) */
  id: string;
  /** Lowercase slug unique across channels — the handle agents speak */
  name: string;
  /** Creator principal label ("sess:<id>" | "user:<id>" | future "peer:...") */
  createdBy: string;
  /** ISO 8601 creation timestamp (DB default) */
  createdAt: string;
}

/**
 * A channel member: membership is exactly "this principal's public key is on
 * the channel's recipient roster" (sealed delivery reads it directly).
 */
export interface ChannelMemberTable {
  /** Owning channel */
  channelId: string;
  /** Member principal label */
  principalId: string;
  /** ISO 8601 timestamp when added (DB default) */
  addedAt: string;
  /** Principal label of whoever added them */
  addedBy: string;
}

/** Per-principal read position in a channel's post log. */
export interface ChannelCursorTable {
  /** Channel the cursor is for */
  channelId: string;
  /** Whose position this is */
  principalId: string;
  /** Highest post seq this principal has read (DB default 0) */
  lastSeq: number;
}
