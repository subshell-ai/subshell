import type { Kysely } from "kysely";
import type { Database } from "@/db/types/index.js";
import type { NotificationSubscriptionTable } from "@/db/types/notification-subscriptions.db-types.js";

/**
 * One row per browser push subscription. `endpoint` is globally unique — a
 * re-authorized browser (even under another user) replaces the row, because
 * the endpoint IS the browser's mailbox: only its current holder can be
 * written to it.
 */
export class NotificationsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async upsertForUser(userId: string, endpoint: string, p256dh: string, auth: string): Promise<void> {
    // bun:sqlite cannot upsert after INSERT…SELECT, but here a plain
    // delete-then-insert beats any ON CONFLICT dance: the row's OWNER may
    // change (shared browser), so "conflict" is a legitimate move, not a no-op.
    // The transaction closes the delete/insert window: a concurrent send sees
    // either the old row or the new one, never nothing, and one concurrent
    // upsert of the same endpoint wins cleanly instead of tripping the unique
    // index with a raw constraint error.
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("notificationsSubscriptions").where("endpoint", "=", endpoint).execute();
      await tx
        .insertInto("notificationsSubscriptions")
        .values({
          id: crypto.randomUUID(),
          userId,
          endpoint,
          p256dh,
          auth,
          createdAt: new Date().toISOString(),
        })
        .execute();
    });
  }

  async deleteForUser(userId: string, endpoint: string): Promise<void> {
    await this.db
      .deleteFrom("notificationsSubscriptions")
      .where("userId", "=", userId)
      .where("endpoint", "=", endpoint)
      .execute();
  }

  async listByUser(userId: string): Promise<NotificationSubscriptionTable[]> {
    return this.db.selectFrom("notificationsSubscriptions").selectAll().where("userId", "=", userId).execute();
  }

  async deleteByEndpoint(endpoint: string): Promise<void> {
    await this.db.deleteFrom("notificationsSubscriptions").where("endpoint", "=", endpoint).execute();
  }
}
