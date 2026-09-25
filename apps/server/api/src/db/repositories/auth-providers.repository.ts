import type { Kysely } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { AuthProviderRow, NewAuthProvider } from "@/db/types/auth-providers.db-types.js";
import type { Database } from "@/db/types/index.js";

/**
 * Data access for `auth_providers` (spec 2026-09-24 §2). Routes and the auth
 * build path read through this; no raw SQL leaves the class. The `email` row
 * is a row like any other here — what refuses its deletion lives in the
 * ROUTE, next to the last-door guard that reads the same table.
 */
export class AuthProvidersRepository extends BaseRepository {
  // Rows are typed `AuthProviderRow` (the plain SELECT shape); the table
  // interface carries `Generated` wrappers, which are insert-time optionality,
  // not what a read hands back.
  async listAll(): Promise<AuthProviderRow[]> {
    return await this.db.selectFrom("authProviders").selectAll().orderBy("position").orderBy("id").execute();
  }

  async getById(id: string): Promise<AuthProviderRow | undefined> {
    return await this.db.selectFrom("authProviders").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async create(input: NewAuthProvider): Promise<void> {
    await this.db.insertInto("authProviders").values(input).execute();
  }

  /** Patches a row and stamps `updatedAt`; `id` and `kind` are not patchable. */
  async update(id: string, patch: Partial<Omit<AuthProviderRow, "id" | "kind">>): Promise<void> {
    await this.db
      .updateTable("authProviders")
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where("id", "=", id)
      .execute();
  }

  async remove(id: string): Promise<boolean> {
    // kysely-bun-sqlite-dialect hands back `numDeletedRows` (a bigint) where
    // Kysely types `numDeleted`, and `execute()` wraps it in an array — the
    // same guard as node-setup-keys' countDeleted / presets.repository.
    const res = await this.db.deleteFrom("authProviders").where("id", "=", id).executeTakeFirst();
    const counts = res as { numDeleted?: number | bigint; numDeletedRows?: number | bigint } | undefined;
    return Number(counts?.numDeletedRows ?? counts?.numDeleted ?? 0) > 0;
  }

  /**
   * How many doors are currently open for signing in: rows with
   * `enabled = 1 AND signInEnabled = 1`. The last-door guard's count.
   */
  async openSignInDoorCount(): Promise<number> {
    return await this.countOpenIn(this.db);
  }

  /**
   * The guard's COUNT written as one unit with its mutation — the
   * `UserMetaRepository.setRole` precedent, whose JSDoc states WHY a plain
   * `db.transaction()` suffices: `bun:sqlite` is synchronous and the dialect
   * hands out ONE shared connection, so the awaits between the SELECT and the
   * write never yield, and concurrent calls serialize in practice. A
   * check-then-write split across statements does NOT: two admins closing two
   * different doors would both read "2 open", both pass, and land the
   * instance at zero ways to sign in.
   *
   * The row is RE-READ inside the transaction, so `wasOpen` is the committed
   * state the count agrees with — never a snapshot from before a concurrent
   * write. `nextOpen` is the post-patch open state the CALLER derived from
   * its patch (the route owns what the fields mean; this owns the arithmetic
   * and the atomicity).
   *
   * @returns "not_found" when no row bears `id`, "last_door" when applying
   *   the patch would close the final open door (nothing written), "ok" when
   *   the patch is committed.
   */
  async patchGuardingLastDoor(
    id: string,
    patch: Partial<Omit<AuthProviderRow, "id" | "kind">>,
    nextOpen: boolean,
  ): Promise<"not_found" | "last_door" | "ok"> {
    return await this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("authProviders").selectAll().where("id", "=", id).executeTakeFirst();
      if (!row) return "not_found" as const;
      const wasOpen = row.enabled === 1 && row.signInEnabled === 1;
      const openOthers = (await this.countOpenIn(trx)) - (wasOpen ? 1 : 0);
      if (openOthers + (nextOpen ? 1 : 0) <= 0) return "last_door" as const;
      await trx
        .updateTable("authProviders")
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where("id", "=", id)
        .execute();
      return "ok" as const;
    });
  }

  /**
   * {@link patchGuardingLastDoor}'s delete twin: removing an OPEN door is
   * refused when it is the only open one; a closed door can always go (the
   * count arithmetic is the same shape, with the row simply not re-appearing).
   */
  async deleteGuardingLastDoor(id: string): Promise<"not_found" | "last_door" | "ok"> {
    return await this.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("authProviders").selectAll().where("id", "=", id).executeTakeFirst();
      if (!row) return "not_found" as const;
      const wasOpen = row.enabled === 1 && row.signInEnabled === 1;
      const openOthers = (await this.countOpenIn(trx)) - (wasOpen ? 1 : 0);
      if (openOthers <= 0) return "last_door" as const;
      await trx.deleteFrom("authProviders").where("id", "=", id).execute();
      return "ok" as const;
    });
  }

  private async countOpenIn(handle: Kysely<Database>): Promise<number> {
    const { count } = await handle
      .selectFrom("authProviders")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("enabled", "=", 1)
      .where("signInEnabled", "=", 1)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
