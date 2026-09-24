import { sql } from "kysely";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import { type ApprovalState, asApprovalState } from "@/db/types/approval-state.js";
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
  /**
   * The auth providers this account actually has `account` rows for — a SET
   * in unspecified order (spec 2026-09-24 §7): a two-provider account may
   * arrive as `["credential","google"]` or the reverse, and consumers must
   * not rely on the ordering. Split from a `GROUP_CONCAT` at this boundary so
   * no consumer knows SQLite aggregates strings — and the aggregate's order
   * is not guaranteed, which is exactly why set semantics is the contract.
   * Empty means no sign-in row at all, which in practice only the `system`
   * service account is.
   */
  providers: string[];
}

/**
 * One row of the approval queue (spec 2026-09-24 §6): a person a door let
 * THROUGH who is not a member yet. `providerName` is NOT here — the route
 * resolves it live through the AuthProvidersRepository, because a deleted
 * provider must render as "removed provider" rather than vanish the row.
 */
export interface PendingApprovalRow {
  /** better-auth user id */
  id: string;
  /** Email the door's profile carried */
  email: string;
  /** Display name (better-auth's `user.name`; empty for a door arrival that carried none) */
  name: string;
  /** The door's `providerId` on the account row, or null for a user with no account row */
  providerId: string | null;
  /** When the row last landed in (or knocked again on) `pending`; null once resolved */
  arrivedAt: string | null;
  /** Queue state — never `approved`; those rows are members, not queue items */
  approvalState: Exclude<ApprovalState, "approved">;
}

/**
 * The predicate that isolates REAL accounts inside better-auth's `user`
 * table: every row except the `system` service account.
 *
 * Spelled once because two questions must never disagree about what "has
 * anybody registered" means: {@link UsersRepository.countRealAccounts} (the
 * registration gate and the setup window read it) and the first-user
 * promotion in `auth.ts`, which used to decide adminhood from emptiness of
 * the `user_meta` ROLE side-table instead — the divergence
 * `registration-gate.ts`'s `hasAnyUser` docstring records as a fixed bug on
 * the gate's side, and security-actionable 2026-09 item 9 closes on the
 * promotion's. Paste after `WHERE`; consumers add their own `AND` terms.
 * The exclusion itself belongs to `countRealAccounts`'s docstring.
 */
export const REAL_ACCOUNT_FILTER = sql`email <> ${SYSTEM_USER_EMAIL}`;

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
   * Lists the MEMBERS with their role and auth providers (app user +
   * `user_meta` + `account` join), newest first.
   *
   * Two filters decide WHO is a member (spec 2026-09-24 §6/§8): rows whose
   * approval state is `pending` or `rejected` are invisible here — the queue
   * is answered by {@link listApprovalQueue}, and members are never told who
   * is pending. That exclusion is defense in depth behind the §6 hook undo;
   * the approval route is the other half. An absent `user_meta` row (or a
   * NULL column from a hand edit) COALESCEs to `approved`, like every other
   * reader of the column: an account predating approval was never in a
   * queue, and a broken value must not lock its owner out of the roster.
   *
   * @returns Rows with `role` null when a user has no user_meta row yet
   */
  async listWithRoles(): Promise<UserWithRole[]> {
    // better-auth's `user`/`account` tables store createdAt and providerId in
    // camelCase; `user_meta` is the app's snake_case table. Raw sql fragments
    // bypass the CamelCasePlugin, so each reference spells its own dialect,
    // and every output alias is deliberately camelCase (the alias, not the
    // column, is what the result key copies).
    const { rows } = await sql<
      Omit<UserWithRole, "disabled" | "providers"> & { disabled: number; providers: string | null }
    >`
      SELECT u.id, u.email, u.name, m.role, u."createdAt" AS createdAt,
             COALESCE(m.disabled, 0) AS disabled,
             GROUP_CONCAT(DISTINCT a.providerId) AS providers
      FROM user u
      LEFT JOIN user_meta m ON m.user_id = u.id
      LEFT JOIN account a ON a.userId = u.id
      WHERE COALESCE(m.approval_state, 'approved') = 'approved'
      GROUP BY u.id
      ORDER BY u."createdAt" DESC
    `.execute(this.db);
    // SQLite has no boolean and no arrays: the 0/1 and the comma-joined
    // provider list become a boolean and a string[] at this boundary so
    // nothing downstream has to know either SQL trick, or that a missing row
    // means enabled.
    return rows.map((row) => ({
      ...row,
      disabled: row.disabled !== 0,
      providers: row.providers ? row.providers.split(",") : [],
    }));
  }

  /**
   * The approval queue: every `pending` or `rejected` row, newest arrival
   * first (spec 2026-09-24 §6 — `rejected` rows persist until an admin acts,
   * which is what lets the tab offer "approve" on them too).
   *
   * A rejected row that left `pending` carries a NULL arrival, and SQLite
   * sorts NULLs last on DESC, so resolved rejections sink below fresh
   * knocks — the ordering a queue wants. `providerId` is the one door the
   * account has; a user with several account rows (credential added by an
   * admin later) reads its minimum, a stable pick rather than a scan-order
   * accident.
   */
  async listApprovalQueue(): Promise<PendingApprovalRow[]> {
    const { rows } = await sql<Omit<PendingApprovalRow, "approvalState"> & { approvalState: string }>`
      SELECT u.id, u.email, u.name, m.approval_state AS approvalState,
             m.pending_arrived_at AS arrivedAt,
             (SELECT MIN(a.providerId) FROM account a WHERE a.userId = u.id) AS providerId
      FROM user u
      JOIN user_meta m ON m.user_id = u.id
      WHERE m.approval_state IN ('pending', 'rejected')
      ORDER BY m.pending_arrived_at DESC, u."createdAt" DESC
    `.execute(this.db);
    return rows.flatMap((row) => {
      const state = asApprovalState(row.approvalState);
      // The WHERE only admits 'pending'/'rejected', so the narrowing can only
      // answer "approved" for a value the filter would already have dropped.
      // Skipping that (impossible) case keeps the row type exact without a
      // cast — and an approved account is never a queue row anyway.
      return state === "approved" ? [] : [{ ...row, approvalState: state }];
    });
  }

  /**
   * The door that created this account, for audit metadata and the approval
   * route — the same MIN pick {@link listApprovalQueue} makes, in both
   * spellings of "which one" so the queue row and the audit row can never
   * name different doors for the same person.
   */
  async primaryProviderId(userId: string): Promise<string | null> {
    const { rows } = await sql<{ providerId: string | null }>`
      SELECT MIN(providerId) AS providerId FROM account WHERE userId = ${userId}
    `.execute(this.db);
    return rows[0]?.providerId ?? null;
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

  /**
   * How many REAL accounts exist: every `user` row except the service one.
   *
   * This is the instance's "has anybody registered yet" truth, and it is
   * counted off `user` rather than `user_meta` deliberately. `user_meta` is a
   * ROLE side-table, written by a separate better-auth `after` hook, and the
   * two already disagree on any instance that has ever minted a system API
   * key: `ensureSystemUser` INSERTs straight into `user` and creates no meta
   * row. A user whose meta row is missing for any other reason — the hook not
   * reached, the app database not yet injected — would then read as "nobody
   * has registered", which silently REOPENS registration and makes the
   * first-run `/api/setup/*` window public again on an instance that has real
   * accounts. Counting the accounts themselves cannot drift that way.
   *
   * The service account is excluded because no credential row exists for it
   * and it can never sign in, so it is not somebody having registered —
   * counting it would close the door before anyone walked through it and
   * brick a fresh install. Same `email !== SYSTEM_USER_EMAIL` rule
   * `users.route.ts` already applies to decide manageability.
   */
  async countRealAccounts(): Promise<number> {
    // Raw sql for better-auth's table, like every other read here; the
    // CamelCasePlugin leaves these physical names untouched.
    const { rows } = await sql<{ n: number }>`
      SELECT count(*) AS n FROM user WHERE ${REAL_ACCOUNT_FILTER}
    `.execute(this.db);
    return Number(rows[0]?.n ?? 0);
  }
}
