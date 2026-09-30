import { type Kysely, sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { Database } from "@/db/types/index.js";
import type {
  NewPromptStack,
  NewPromptStackItem,
  PromptStackItemTable,
  PromptStackTable,
  PromptStackUpdate,
} from "@/db/types/prompt-stacks.db-types.js";

/**
 * A member's referenced prompt row is gone by the time the WRITE runs: the
 * route's visibility check passed a row that was deleted in the sliver
 * between check and insert (a DELETE or an MCP sibling acting as the owner).
 * Thrown INSIDE the write transaction - nothing was committed - so the route
 * can answer it as a 400 retry instead of leaking the FK constraint's status-
 * less 500. The FK stays the backstop; this is the explanation.
 */
export class StackMemberReferenceGone extends Error {
  constructor() {
    super("A stack member references a prompt that no longer exists");
  }
}

/**
 * Repository for prompt stacks (spec 2026-09-29). Stack rows read exactly like
 * prompt rows (own / shared-with-me, newest-updated); the item rows are a full
 * ordered replace on every save, so reordering, adding and removing are all
 * "rewrite the member list" and the caller never reasons about ordinals.
 *
 * The delete rule that lets a stack go EMPTY is NOT here: it is the
 * `prompt_stack_items.prompt_id` ON DELETE CASCADE, applied by SQLite when a
 * prompt is removed. A referenced prompt going UNSHARED is likewise not a row
 * change - the read view (in the route) drops members the caller cannot see.
 */
export class PromptStacksRepository extends BaseRepository {
  async create(stack: NewPromptStack): Promise<PromptStackTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("promptStacks")
      .values({
        ...stack,
        shared: stack.shared ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<PromptStackTable | undefined> {
    return this.db.selectFrom("promptStacks").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** The owner's own stacks, newest-updated first (id as the stable tiebreak). */
  async listOwn(userId: string): Promise<PromptStackTable[]> {
    return this.db
      .selectFrom("promptStacks")
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("updatedAt", "desc")
      .orderBy("id", "asc")
      .execute();
  }

  /**
   * Everyone-else's shared stacks, newest-updated first. The caller's OWN
   * shared rows never ride it (the page would show them twice), the prompts
   * rule verbatim; owner labels resolve through `UsersRepository` in the route.
   */
  async listShared(excludingUserId: string): Promise<PromptStackTable[]> {
    return this.db
      .selectFrom("promptStacks")
      .selectAll()
      .where("shared", "=", 1)
      .where("userId", "!=", excludingUserId)
      .orderBy("updatedAt", "desc")
      .orderBy("id", "asc")
      .execute();
  }

  async update(id: string, update: PromptStackUpdate): Promise<PromptStackTable | undefined> {
    await this.db
      .updateTable("promptStacks")
      .set({ ...update, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where("id", "=", id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("promptStacks").where("id", "=", id).execute();
  }

  /**
   * Every member row for the given stacks, ordinal-ordered within each. Batched
   * for the list read (one query, not N). The route groups them by stack.
   */
  async listItemsForStacks(stackIds: readonly string[]): Promise<PromptStackItemTable[]> {
    if (stackIds.length === 0) return [];
    return this.db
      .selectFrom("promptStackItems")
      .selectAll()
      .where("stackId", "in", [...stackIds])
      .orderBy("stackId", "asc")
      .orderBy("ordinal", "asc")
      .execute();
  }

  /**
   * Every referenced prompt still EXISTS. Existence, not visibility: an
   * unshared-in-flight reference is the ordinary later-unshare shape the read
   * already hides, while a DELETED row would blow the FK inside the
   * transaction as a status-less 500. Run it as the transaction's first
   * statement, over the new members AND the preserved rows (whose snapshot
   * predates the window).
   */
  private async assertPromptRefs(
    db: Pick<Kysely<Database>, "selectFrom">,
    items: readonly { promptId?: string | null }[],
  ): Promise<void> {
    const ids = [...new Set(items.flatMap((i) => (i.promptId ? [i.promptId] : [])))];
    if (ids.length === 0) return;
    const found = await db.selectFrom("prompts").select("id").where("id", "in", ids).execute();
    if (found.length < ids.length) throw new StackMemberReferenceGone();
  }

  /**
   * Save a stack in ONE transaction: the referenced-prompt check, the full
   * ordered member rewrite (ordinal = index), and the stack-row patch land
   * together or not at all. Splitting them let a save commit the member
   * rewrite while label/shared silently stayed old (the error said the whole
   * save failed), and let a prompt deleted mid-window blow the FK as a 500
   * after the earlier reads had promised success. Ids are minted here;
   * callers hand in bodies/references only.
   *
   * `preserve` names rows the CALLER could not have written (members whose
   * prompt is invisible to them - the read dropped them from the view, so the
   * save cannot name them). They are carried through with their id, promptId,
   * body and description intact and land behind the rewritten set in their
   * relative order: a visible-set rewrite must not destroy what the visibility
   * rule only HID (the "returns on re-share" ruling depends on the row still
   * being there).
   */
  async updateWithItems(
    stackId: string,
    patch: { label: string; shared: number },
    items: readonly NewPromptStackItem[],
    preserve: readonly PromptStackItemTable[] = [],
  ): Promise<{ stack: PromptStackTable; items: PromptStackItemTable[] }> {
    return this.db.transaction().execute(async (trx) => {
      await this.assertPromptRefs(trx, [...items, ...preserve]);
      // Delete the whole member set, then insert new-then-preserved in ONE
      // transaction. (Keeping the preserved rows in place and renumbering them
      // afterward trips the unique (stack_id, ordinal): the survivors still
      // hold the low ordinals the fresh rows are inserted at, and a
      // mid-transaction collision aborts the rewrite. Re-inserting a preserved
      // row under its own id is the same row for every later read - the id,
      // not the storage episode, is what re-share resolves through.)
      await trx.deleteFrom("promptStackItems").where("stackId", "=", stackId).execute();
      const rows = [
        ...items.map((item, index) => ({
          id: crypto.randomUUID(),
          stackId,
          ordinal: index,
          promptId: item.promptId,
          body: item.body,
          description: item.description,
        })),
        ...preserve.map((kept, index) => ({
          id: kept.id,
          stackId,
          ordinal: items.length + index,
          promptId: kept.promptId,
          body: kept.body,
          description: kept.description,
        })),
      ];
      if (rows.length > 0) {
        await trx.insertInto("promptStackItems").values(rows).execute();
      }
      const stack = await trx
        .updateTable("promptStacks")
        .set({ ...patch, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
        .where("id", "=", stackId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const listed = await trx
        .selectFrom("promptStackItems")
        .selectAll()
        .where("stackId", "=", stackId)
        .orderBy("ordinal", "asc")
        .execute();
      return { stack, items: listed };
    });
  }

  /**
   * Mint a stack AND its ordered members in ONE transaction. Create is
   * all-or-nothing: a referenced prompt deleted in the sliver between the
   * route's visibility check and here throws before anything is inserted, so a
   * failed create never strands an empty stack the caller must then delete by
   * hand. Returns the created row and its ordinal-ordered items.
   */
  async createWithItems(
    stack: NewPromptStack,
    items: readonly NewPromptStackItem[],
  ): Promise<{ stack: PromptStackTable; items: PromptStackItemTable[] }> {
    const now = new Date().toISOString();
    return this.db.transaction().execute(async (trx) => {
      // Same in-transaction check as the save path: a prompt deleted after the
      // route's visibility read dies here as StackMemberReferenceGone (the
      // transaction never opens its inserts), not as the FK's status-less 500.
      await this.assertPromptRefs(trx, items);
      const created = await trx
        .insertInto("promptStacks")
        .values({ ...stack, shared: stack.shared ?? 0, createdAt: now, updatedAt: now })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (items.length > 0) {
        await trx
          .insertInto("promptStackItems")
          .values(
            items.map((item, index) => ({
              id: crypto.randomUUID(),
              stackId: created.id,
              ordinal: index,
              promptId: item.promptId,
              body: item.body,
              description: item.description,
            })),
          )
          .execute();
      }
      const listed =
        items.length === 0
          ? []
          : await trx
              .selectFrom("promptStackItems")
              .selectAll()
              .where("stackId", "=", created.id)
              .orderBy("ordinal", "asc")
              .execute();
      return { stack: created, items: listed };
    });
  }

  /** Ordinal-ordered members of one stack (the detail read). */
  async listItems(stackId: string): Promise<PromptStackItemTable[]> {
    return this.db
      .selectFrom("promptStackItems")
      .selectAll()
      .where("stackId", "=", stackId)
      .orderBy("ordinal", "asc")
      .execute();
  }
}
