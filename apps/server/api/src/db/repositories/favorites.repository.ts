import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { FavoriteKind } from "@/db/types/favorites.db-types.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";

/**
 * Repository for per-user favorites (the folder picker's starred paths;
 * future kinds reuse it unchanged). Scoped per NODE like `recent_paths`:
 * a path means something only on the machine whose filesystem holds it.
 */
export class FavoritesRepository extends BaseRepository {
  /** Lists one kind of the user's favorites ON ONE NODE, newest star first. */
  async listByUser(
    userId: string,
    kind: FavoriteKind,
    nodeId = LOCAL_NODE_ID,
    limit = 20,
  ): Promise<{ ref: string; label: string | null }[]> {
    return this.db
      .selectFrom("favorites")
      .select(["ref", "label"])
      .where("userId", "=", userId)
      .where("kind", "=", kind)
      .where("nodeId", "=", nodeId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .execute();
  }

  /**
   * Stars/unstars one entity. Unstarring is a delete, so it never invents a
   * row for a path that was never starred.
   */
  async setFavorite(
    userId: string,
    kind: FavoriteKind,
    ref: string,
    favorite: boolean,
    nodeId = LOCAL_NODE_ID,
  ): Promise<void> {
    if (!favorite) {
      await this.db
        .deleteFrom("favorites")
        .where("userId", "=", userId)
        .where("kind", "=", kind)
        .where("nodeId", "=", nodeId)
        .where("ref", "=", ref)
        .execute();
      return;
    }
    await this.db
      .insertInto("favorites")
      .values({
        id: crypto.randomUUID(),
        userId,
        nodeId,
        kind,
        ref,
        label: null,
        // The column defaults in the DB (migration 0012); mirror it so the
        // typed insert is complete.
        createdAt: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(["userId", "nodeId", "kind", "ref"]).doNothing())
      .execute();
  }
}
