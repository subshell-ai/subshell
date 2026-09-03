import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { ChannelPostTable } from "@/db/types/channel-posts.db-types.js";

/** Input for an immutable append. */
export interface AppendPostInput {
  /** Channel being posted into */
  channelId: string;
  /** Author principal label (derived from the caller's token upstream) */
  author: string;
  /** General JWE JSON — stored verbatim, never parsed here */
  envelope: string;
  /** Every recipient must already be a channel member (route-enforced) */
  recipientIds: string[];
}

/**
 * The append-only post log plus per-principal read cursors.
 *
 * Posts are immutable (no update/delete shapes exist by design) and the
 * recipient list is denormalized into `channel_post_recipients` so
 * {@link listVisible} can filter portably to "posts you can decrypt" —
 * readers never receive noise they cannot open.
 */
export class ChannelPostsRepository extends BaseRepository {
  /**
   * Appends one post, assigning the next per-channel seq inside a
   * transaction (MAX+1 is race-free under SQLite's single-writer model).
   */
  async append(input: AppendPostInput): Promise<{ id: string; seq: number }> {
    const id = crypto.randomUUID();
    const seq = await this.db.transaction().execute(async (tx) => {
      const agg = await tx
        .selectFrom("channelPosts")
        .select((eb) => eb.fn.max("seq").as("maxSeq"))
        .where("channelId", "=", input.channelId)
        .executeTakeFirstOrThrow();
      const next = (agg.maxSeq ?? 0) + 1;
      await tx
        .insertInto("channelPosts")
        .values({
          id,
          channelId: input.channelId,
          seq: next,
          author: input.author,
          envelope: input.envelope,
          createdAt: new Date().toISOString(),
        })
        .execute();
      await tx
        .insertInto("channelPostRecipients")
        .values(input.recipientIds.map((principalId) => ({ postId: id, principalId })))
        .execute();
      return next;
    });
    return { id, seq };
  }

  /**
   * Posts in one channel the principal can see (recipient-filtered), seq
   * ascending, strictly after `since`, capped at `limit`.
   */
  async listVisible(input: {
    channelId: string;
    principalId: string;
    since: number;
    limit: number;
  }): Promise<ChannelPostTable[]> {
    return await this.db
      .selectFrom("channelPosts")
      .innerJoin("channelPostRecipients", (join) =>
        join
          .onRef("channelPostRecipients.postId", "=", "channelPosts.id")
          .on("channelPostRecipients.principalId", "=", input.principalId),
      )
      .where("channelPosts.channelId", "=", input.channelId)
      .where("channelPosts.seq", ">", input.since)
      .orderBy("channelPosts.seq", "asc")
      .limit(input.limit)
      .select([
        "channelPosts.id",
        "channelPosts.channelId",
        "channelPosts.seq",
        "channelPosts.author",
        "channelPosts.envelope",
        "channelPosts.createdAt",
      ])
      .execute();
  }

  /** How many posts after `since` are addressed to the principal (unread badge). */
  async countVisibleAfter(input: { channelId: string; principalId: string; since: number }): Promise<number> {
    const row = await this.db
      .selectFrom("channelPosts")
      .innerJoin("channelPostRecipients", (join) =>
        join
          .onRef("channelPostRecipients.postId", "=", "channelPosts.id")
          .on("channelPostRecipients.principalId", "=", input.principalId),
      )
      .where("channelPosts.channelId", "=", input.channelId)
      .where("channelPosts.seq", ">", input.since)
      .select((eb) => eb.fn.countAll<number>().as("unread"))
      .executeTakeFirstOrThrow();
    return Number(row.unread);
  }

  /** Highest seq in the channel (0 when empty). */
  async maxSeq(channelId: string): Promise<number> {
    const agg = await this.db
      .selectFrom("channelPosts")
      .select((eb) => eb.fn.max("seq").as("maxSeq"))
      .where("channelId", "=", channelId)
      .executeTakeFirstOrThrow();
    return agg.maxSeq ?? 0;
  }

  /** The principal's read position (0 when never read). */
  async getCursor(input: { channelId: string; principalId: string }): Promise<number> {
    const row = await this.db
      .selectFrom("channelCursors")
      .select("lastSeq")
      .where("channelId", "=", input.channelId)
      .where("principalId", "=", input.principalId)
      .executeTakeFirst();
    return row?.lastSeq ?? 0;
  }

  /** Advances the cursor; never moves backwards (monotonic by construction). */
  async setCursor(input: { channelId: string; principalId: string; lastSeq: number }): Promise<void> {
    await this.db
      .insertInto("channelCursors")
      .values({ channelId: input.channelId, principalId: input.principalId, lastSeq: input.lastSeq })
      .onConflict((oc) =>
        // Never rewind: with racing readers the higher seq wins.
        oc.columns(["channelId", "principalId"]).doUpdateSet({
          lastSeq: sql`max("channel_cursors"."last_seq", excluded."last_seq")`,
        }),
      )
      .execute();
  }
}
