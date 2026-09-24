import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { AuthProviderRow, NewAuthProvider } from "@/db/types/auth-providers.db-types.js";

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
    const { count } = await this.db
      .selectFrom("authProviders")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("enabled", "=", 1)
      .where("signInEnabled", "=", 1)
      .executeTakeFirstOrThrow();
    return Number(count);
  }
}
