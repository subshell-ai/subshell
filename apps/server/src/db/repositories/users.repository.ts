import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";

/**
 * App-side user row shape for admin listing (auth `user` + `user_meta` join).
 */
export interface UserWithRole {
  /** better-auth user id */
  id: string;
  /** User email address (unique) */
  email: string;
  /** App role: "admin" | "user" | null when no user_meta row exists */
  role: string | null;
  /** ISO 8601 timestamp of the user row creation */
  createdAt: string | null;
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
    const { rows } = await sql<UserWithRole>`
      SELECT u.id, u.email, m.role, u."createdAt" AS createdAt
      FROM user u
      LEFT JOIN user_meta m ON m.user_id = u.id
      ORDER BY u."createdAt" DESC
    `.execute(this.db);
    return rows;
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
   * @param input - Email, hashed password (use `hashPassword` from `better-auth/crypto`) and role
   * @returns The new user's id
   * @throws On duplicate email (the `user.email` unique constraint fires a raw
   * SQLite error; callers map it to a 409)
   */
  async createUser(input: { email: string; passwordHash: string; role: "admin" | "user" }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // user id doubles as the credential accountId (issuer local:credential),
    // matching what better-auth itself writes on sign-up.
    await sql`
      INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt)
      VALUES (${id}, ${input.email}, ${input.email}, 0, NULL, ${now}, ${now})
    `.execute(this.db);
    await sql`
      INSERT INTO account (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt)
      VALUES (${id}, ${"local:credential"}, ${id}, ${"credential"}, ${id}, ${input.passwordHash}, ${now}, ${now})
    `.execute(this.db);
    await this.db.insertInto("userMeta").values({ userId: id, role: input.role }).execute();
    return id;
  }
}
