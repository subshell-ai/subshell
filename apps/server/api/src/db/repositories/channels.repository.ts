import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { ChannelMemberTable, ChannelTable } from "@/db/types/channels.db-types.js";

/** Thrown when a channel slug is already taken (mapped to 409 by the route). */
export class ChannelNameTakenError extends Error {
  override readonly name = "ChannelNameTakenError";
  constructor(slug: string) {
    super(`channel name taken: ${slug}`);
  }
}

/** A channel row enriched with the list-view counters. */
export interface ChannelListItem extends ChannelTable {
  /** Current member count */
  memberCount: number;
  /** Highest posted seq (0 when empty) */
  lastSeq: number;
}

/**
 * Channels and their membership roster. Membership is exactly "this
 * principal's identity is on the channel's list" — sealed delivery reads the
 * roster directly, so there is no second membership concept to keep in sync.
 */
export class ChannelsRepository extends BaseRepository {
  /** Creates a channel; throws {@link ChannelNameTakenError} on slug conflict. */
  async create(input: { id: string; name: string; createdBy: string }): Promise<ChannelTable> {
    try {
      return await this.db
        .insertInto("channels")
        .values({ id: input.id, name: input.name, createdBy: input.createdBy, createdAt: new Date().toISOString() })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE constraint failed: channels.name")) {
        throw new ChannelNameTakenError(input.name);
      }
      throw err;
    }
  }

  /** Looks a channel up by its unique slug. */
  async findByName(name: string): Promise<ChannelTable | undefined> {
    return this.db.selectFrom("channels").selectAll().where("name", "=", name).executeTakeFirst();
  }

  /** Lists every channel with member/post counters, oldest first. */
  async listWithCounts(): Promise<ChannelListItem[]> {
    // Correlated subqueries, not joins: two joined one-to-many tables would
    // multiply rows and poison both counts.
    const rows = await this.db
      .selectFrom("channels")
      .selectAll("channels")
      .select((eb) => [
        eb
          .selectFrom("channelMembers")
          .whereRef("channelMembers.channelId", "=", "channels.id")
          .select((eb2) => eb2.fn.countAll<number>().as("cnt"))
          .as("memberCount"),
        eb
          .selectFrom("channelPosts")
          .whereRef("channelPosts.channelId", "=", "channels.id")
          .select((eb2) => eb2.fn.coalesce(eb2.fn.max("seq"), eb2.lit(0)).as("cnt"))
          .as("lastSeq"),
      ])
      .orderBy("createdAt", "asc")
      .execute();
    return rows.map((r) => ({ ...r, memberCount: Number(r.memberCount), lastSeq: Number(r.lastSeq) }));
  }

  /** Adds a member. Idempotent: re-joining an existing member is a no-op. */
  async addMember(input: { channelId: string; principalId: string; addedBy: string }): Promise<void> {
    await this.db
      .insertInto("channelMembers")
      .values({
        channelId: input.channelId,
        principalId: input.principalId,
        addedBy: input.addedBy,
        addedAt: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(["channelId", "principalId"]).doNothing())
      .execute();
  }

  /** The channel's roster in join order. */
  async members(channelId: string): Promise<ChannelMemberTable[]> {
    return this.db
      .selectFrom("channelMembers")
      .selectAll()
      .where("channelId", "=", channelId)
      .orderBy("addedAt", "asc")
      .execute();
  }
}
