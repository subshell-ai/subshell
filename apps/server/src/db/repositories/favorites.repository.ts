import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { FavoriteKind } from "@/db/types/favorites.db-types.js";

/**
 * Repository for per-user favorites (the folder picker's starred paths;
 * future kinds reuse it unchanged).
 */
export class FavoritesRepository extends BaseRepository {
  /** Lists one kind of the user's favorites, newest star first. */
  async listByUser(userId: string, kind: FavoriteKind, limit = 20): Promise<{ ref: string; label: string | null }[]> {
    return this.db
      .selectFrom("favorites")
      .select(["ref", "label"])
      .where("userId", "=", userId)
      .where("kind", "=", kind)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .execute();
  }

  /**
   * Stars/unstars one entity. Unstarring is a delete, so it never invents a
   * row for a path that was never starred.
   */
  async setFavorite(userId: string, kind: FavoriteKind, ref: string, favorite: boolean): Promise<void> {
    if (!favorite) {
      await this.db
        .deleteFrom("favorites")
        .where("userId", "=", userId)
        .where("kind", "=", kind)
        .where("ref", "=", ref)
        .execute();
      return;
    }
    await this.db
      .insertInto("favorites")
      .values({
        id: crypto.randomUUID(),
        userId,
        kind,
        ref,
        label: null,
        // The column defaults in the DB (migration 0012); mirror it so the
        // typed insert is complete.
        createdAt: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(["userId", "kind", "ref"]).doNothing())
      .execute();
  }
}
