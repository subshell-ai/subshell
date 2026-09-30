import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewPrompt, PromptTable, PromptUpdate } from "@/db/types/prompts.db-types.js";

/**
 * Repository for saved prompts (spec 2026-09-28). Deleting one removes the
 * row outright; the only persistent things that referenced a prompt are
 * stack membership rows, which the FK cascade sweeps with it (the stack keeps
 * existing, possibly empty - spec 2026-09-29). Beyond that, the only trace
 * after a delete is text already typed into a pane or an already launched
 * subshell, which is the user's own doing.
 */
export class PromptsRepository extends BaseRepository {
  async create(prompt: NewPrompt): Promise<PromptTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("prompts")
      .values({
        ...prompt,
        shared: prompt.shared ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<PromptTable | undefined> {
    return this.db.selectFrom("prompts").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** The owner's own prompts, newest-updated first (the page's default order). */
  async listOwn(userId: string): Promise<PromptTable[]> {
    return (
      this.db
        .selectFrom("prompts")
        .selectAll()
        .where("userId", "=", userId)
        // id as a tiebreak: two writes in one millisecond share an updatedAt
        // string, and an unordered tie swaps between refetches.
        .orderBy("updatedAt", "desc")
        .orderBy("id", "asc")
        .execute()
    );
  }

  /**
   * Everyone-else's shared prompts, newest-updated first. The caller's OWN
   * shared rows never ride this list (the page would show them twice; the
   * picker would offer one prompt under two tabs), and the owner label is
   * resolved by the caller through `UsersRepository.displayNamesByIds` — the
   * same composition `#shareViews` uses, so this stays a single-table read.
   */
  async listShared(excludingUserId: string): Promise<PromptTable[]> {
    return (
      this.db
        .selectFrom("prompts")
        .selectAll()
        .where("shared", "=", 1)
        .where("userId", "!=", excludingUserId)
        // Same-millisecond ties ride the id, the way listOwn does.
        .orderBy("updatedAt", "desc")
        .orderBy("id", "asc")
        .execute()
    );
  }

  /**
   * A batched read of the prompts named by `ids` (the stack list view resolves
   * every referenced member in ONE query, not one findById per item). Rows the
   * id set does not name are simply absent; the caller (the stack route) decides
   * visibility per member from the row's `userId` / `shared`.
   */
  async listByIds(ids: readonly string[]): Promise<PromptTable[]> {
    if (ids.length === 0) return [];
    return this.db
      .selectFrom("prompts")
      .selectAll()
      .where("id", "in", [...ids])
      .execute();
  }

  async update(id: string, update: PromptUpdate): Promise<PromptTable | undefined> {
    await this.db
      .updateTable("prompts")
      // The ISO-millis format, the same as `create` and the column default:
      // `datetime('now')` yields a space-separated form that string-sorts
      // BELOW every ISO row (the workspaces bug, 2026-09-14).
      .set({ ...update, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where("id", "=", id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("prompts").where("id", "=", id).execute();
  }
}
