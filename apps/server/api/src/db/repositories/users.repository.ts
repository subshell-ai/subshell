import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { UserRole } from "@/db/types/user-role.js";

/**
 * App-side user row shape for admin listing (auth `user` + `user_meta` join).
 */
export interface UserWithRole {
  /** better-auth user id */
  id: string;
  /** User email address (unique) */
  email: string;
  /** Display name, chosen at account creation (better-auth's `user.name`) */
  name: string;
  /** App role: "admin" | "user" | null when no user_meta row exists */
  role: string | null;
  /** ISO 8601 timestamp of the user row creation */
  createdAt: string | null;
  /**
   * True when the account is disabled and cannot authenticate. A user with no
   * `user_meta` row is ENABLED, and that rule is applied HERE (in SQL) rather
   * than left for each consumer to re-derive from a nullable column.
   */
  disabled: boolean;
}

/**
 * Admin user management over better-auth's `user`/`account` tables plus the
 * app's `user_meta` role table.
 *
 * better-auth's tables are owned by better-auth and are NOT part of the typed
 * `Database` interface, so queries against them use raw `sql` fragments with
 * the real column names (`providerId`, `accountId`, ... — better-auth creates
 * those tables with camelCase columns; `user_meta` uses the app's snake_case
 * convention). Only the app's own `user_meta` row goes through the typed
 * query builder.
 */
export class UsersRepository extends BaseRepository {
  /**
   * Lists all users with their role (app user + user_meta join), newest first.
   * @returns Rows with `role` null when a user has no user_meta row yet
   */
  async listWithRoles(): Promise<UserWithRole[]> {
    // better-auth's `user` table stores createdAt in camelCase; `user_meta`
    // is the app's snake_case table. raw sql fragments bypass the
    // CamelCasePlugin, so each reference spells its own dialect.
    const { rows } = await sql<Omit<UserWithRole, "disabled"> & { disabled: number }>`
      SELECT u.id, u.email, u.name, m.role, u."createdAt" AS createdAt,
             COALESCE(m.disabled, 0) AS disabled
      FROM user u
      LEFT JOIN user_meta m ON m.user_id = u.id
      ORDER BY u."createdAt" DESC
    `.execute(this.db);
    // SQLite has no boolean; the 0/1 becomes one at this boundary so nothing
    // downstream has to know that, or that a missing row means enabled.
    return rows.map((row) => ({ ...row, disabled: row.disabled !== 0 }));
  }

  /**
   * Display labels (name, falling back to email) for a set of user ids, for
   * rendering sharing grants. Only ids that still exist come back, so callers
   * can detect a removed grantee (missing from the map).
   */
  async displayNamesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    // Raw sql bypasses the CamelCasePlugin, so better-auth's camelCase `name`
    // column is quoted; `COALESCE(NULLIF(...))` prefers a real name over email.
    const { rows } = await sql<{ id: string; label: string }>`
      SELECT id, COALESCE(NULLIF(name, ''), email) AS label
      FROM user
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))})
    `.execute(this.db);
    return new Map(rows.map((r) => [r.id, r.label]));
  }

  /**
   * Creates a credential account user (mirrors better-auth's own registration
   * insert shape): a `user` row, a `credential` `account` row with the hashed
   * password, and the app `user_meta` role row.
   *
   * `name` is written to `user.name` verbatim — the caller decides what a
   * person is called, and is expected to have trimmed it. It used to be the
   * email, because nothing asked for a name; every account-creating surface
   * asks now, so there is no fallback to drift back into.
   *
   * @param input - Display name, email, hashed password (use `hashPassword` from `better-auth/crypto`) and role
   * @returns The new user's id
   * @throws On duplicate email (the `user.email` unique constraint fires a raw
   * SQLite error; callers map it to a 409)
   */
  async createUser(input: { name: string; email: string; passwordHash: string; role: UserRole }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // user id doubles as the credential accountId (issuer local:credential),
    // matching what better-auth itself writes on sign-up.
    await sql`
      INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
      VALUES (${id}, ${input.name}, ${input.email}, 0, NULL, ${now}, ${now})
    `.execute(this.db);
    await sql`
      INSERT INTO account (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt)
      VALUES (${id}, ${"local:credential"}, ${id}, ${"credential"}, ${id}, ${input.passwordHash}, ${now}, ${now})
    `.execute(this.db);
    await this.db.insertInto("userMeta").values({ userId: id, role: input.role }).execute();
    return id;
  }

  /**
   * One user's id and email, or undefined when the id names nobody.
   *
   * Deliberately minimal: the admin surfaces that use it need to know the user
   * EXISTS and which address to name in an audit line, and nothing else — so
   * this cannot become the accidental route by which a password hash or a
   * session token reaches a handler.
   */
  async findByIdBasic(id: string): Promise<{ id: string; email: string } | undefined> {
    const { rows } = await sql<{ id: string; email: string }>`
      SELECT id, email FROM user WHERE id = ${id}
    `.execute(this.db);
    return rows[0];
  }

  /**
   * Overwrites a user's credential password and signs out every session they
   * hold.
   *
   * The revocation is not incidental. An admin resetting a password is usually
   * answering "this account may be compromised", and leaving the existing
   * cookies alive means the reset changes nothing for someone already holding
   * one. Both writes are one transaction so a password can never be replaced
   * while the old sessions survive.
   *
   * Refuses a user with no credential account rather than creating one:
   * inventing a password login for an account that deliberately had none is a
   * different operation from resetting one, and doing it by accident is how a
   * passwordless account silently gains a way in.
   *
   * @param passwordHash - already hashed by better-auth's `hashPassword`; this
   *   method never sees a plaintext password, so it can never log one
   * @returns the number of sessions revoked, or null when there is no
   *   credential account to reset
   */
  async setPassword(userId: string, passwordHash: string): Promise<number | null> {
    return await this.db.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      // `providerId = 'credential'` is the local password account better-auth
      // writes at sign-up and `createUser` mirrors; an OAuth row must not be
      // rewritten with a password.
      const { rows } = await sql<{ id: string }>`
        SELECT id FROM account WHERE userId = ${userId} AND providerId = ${"credential"}
      `.execute(trx);
      if (rows.length === 0) return null;

      await sql`
        UPDATE account SET password = ${passwordHash}, updatedAt = ${now}
        WHERE userId = ${userId} AND providerId = ${"credential"}
      `.execute(trx);
      const revoked = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM session WHERE userId = ${userId}`.execute(trx);
      await sql`DELETE FROM session WHERE userId = ${userId}`.execute(trx);
      return Number(revoked.rows[0]?.n ?? 0);
    });
  }
}
