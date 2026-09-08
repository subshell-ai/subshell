import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";

/**
 * Repository for recently-used working directories (folder picker quick picks).
 */
export class RecentPathsRepository extends BaseRepository {
  /**
   * Lists the most recently used paths for a user on ONE node (newest first,
   * capped). The read side deliberately matches {@link touch}'s per-node write
   * side: a remote node's paths never leak into the local picker (and vice
   * versa). Phase-0 data is all 'local', so the default changes nothing today.
   */
  async listByUser(
    userId: string,
    limit = 20,
    nodeId = LOCAL_NODE_ID,
  ): Promise<{ path: string; label: string | null }[]> {
    return this.db
      .selectFrom("recentPaths")
      .select(["path", "label"])
      .where("userId", "=", userId)
      .where("nodeId", "=", nodeId)
      .orderBy("lastUsedAt", "desc")
      .limit(limit)
      .execute();
  }

  /** Records a path use, upserting by (user, node, path) and bumping lastUsedAt. */
  async touch(userId: string, path: string, label?: string | null, nodeId = LOCAL_NODE_ID): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("recentPaths")
      .values({
        id: crypto.randomUUID(),
        userId,
        path,
        label: label ?? null,
        nodeId,
        lastUsedAt: now,
      })
      .onConflict((oc) =>
        oc.columns(["userId", "nodeId", "path"]).doUpdateSet({
          label: label ?? null,
          lastUsedAt: sql`excluded.last_used_at`,
        }),
      )
      .execute();
  }
}
