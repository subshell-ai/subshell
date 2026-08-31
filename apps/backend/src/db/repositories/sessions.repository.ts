import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewSession, SessionTable, SessionUpdate } from "@/db/types/sessions.db-types.js";

/** The three fields {@link summarizeSessions} reads off a session row. */
type SummarizableSession = Pick<SessionTable, "status" | "alive" | "waitingSince">;

/**
 * The badge counts derived from a set of session rows: `waiting` is the
 * ratified formula (status='running' AND alive=1 AND waiting_since IS NOT
 * NULL); `running` counts alive rows only. Plain row-scan, not SQL aggregates:
 * per-user session lists are small on a local instance, and keeping the
 * predicate in one readable place beats three COUNT subqueries.
 *
 * Exported so both the owner-only {@link SessionsRepository.countsByUser} and
 * the sharing-aware visible summary reduce over the SAME formula (single source
 * of truth — they must never drift).
 */
export function summarizeSessions(rows: SummarizableSession[]): { total: number; running: number; waiting: number } {
  let running = 0;
  let waiting = 0;
  for (const r of rows) {
    const alive = r.status === "running" && r.alive === 1;
    if (alive) running += 1;
    if (alive && r.waitingSince != null) waiting += 1;
  }
  return { total: rows.length, running, waiting };
}

/**
 * Repository for agent sessions.
 * DB rows are a record of intent; liveness comes from the tmux runner.
 */
export class SessionsRepository extends BaseRepository {
  async create(session: NewSession): Promise<SessionTable> {
    return this.db
      .insertInto("sessions")
      .values({
        ...session,
        // Liveness/auto-restart columns default in the DB (migration 0003);
        // mirror those defaults here so the row is complete on read-back.
        alive: session.alive ?? 1,
        backoffCount: session.backoffCount ?? 0,
        restartOnExit: session.restartOnExit ?? 0,
        nameLocked: session.nameLocked ?? 0,
        notify: session.notify ?? 0,
        waitingSince: session.waitingSince ?? null,
        status: session.status ?? "running",
        createdAt: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<SessionTable | undefined> {
    return this.db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Lists sessions by owner, newest first. */
  async listByUser(userId: string, status?: SessionTable["status"]): Promise<SessionTable[]> {
    let query = this.db.selectFrom("sessions").selectAll().where("userId", "=", userId).orderBy("createdAt", "desc");
    if (status) query = query.where("status", "=", status);
    return query.execute();
  }

  /**
   * Sessions a viewer may SEE (spec 2026-08-31 §4.3): their own, plus any
   * shared with Everyone (a `session_shares` row with a NULL grantee) or named
   * directly, newest first. An admin sees every session. A private foreign
   * session never appears — the whole list reads as "no such session", so a
   * stranger cannot probe which ids exist.
   *
   * This is the WHERE-clause half of visibility; the resolver
   * (`lib/session-access`) is the access-level half. Both key off the same
   * `granteeUserId IS NULL OR = viewer` rule.
   */
  async listVisibleTo(viewerId: string, isAdmin: boolean, status?: SessionTable["status"]): Promise<SessionTable[]> {
    let query = this.db.selectFrom("sessions");
    if (!isAdmin) {
      query = query.where((eb) =>
        eb.or([
          eb("sessions.userId", "=", viewerId),
          eb.exists(
            eb
              .selectFrom("sessionShares")
              .whereRef("sessionShares.sessionId", "=", "sessions.id")
              .where((e) =>
                e.or([e("sessionShares.granteeUserId", "is", null), e("sessionShares.granteeUserId", "=", viewerId)]),
              )
              .select("sessionShares.sessionId"),
          ),
        ]),
      );
    }
    query = query.orderBy("createdAt", "desc");
    if (status) query = query.where("status", "=", status);
    return query.selectAll().execute();
  }

  /**
   * Badge/summary counts for one owner (spec §Backend diff), via
   * {@link summarizeSessions}.
   * @param userId - Owner whose sessions are counted
   * @returns `{ total, running, waiting }`
   */
  async countsByUser(userId: string): Promise<{ total: number; running: number; waiting: number }> {
    const rows = await this.db
      .selectFrom("sessions")
      .select(["status", "alive", "waitingSince"])
      .where("userId", "=", userId)
      .execute();
    return summarizeSessions(rows);
  }

  /**
   * Badge counts over everything a viewer can SEE (own + shared; all for an
   * admin) — the same visible set {@link listVisibleTo} returns, reduced with
   * the shared {@link summarizeSessions} formula. Selects only the three needed
   * columns.
   */
  async countsVisibleTo(
    viewerId: string,
    isAdmin: boolean,
  ): Promise<{ total: number; running: number; waiting: number }> {
    // Delegates to listVisibleTo so there is exactly ONE definition of
    // "what a viewer can see" — counts and list can never disagree about the
    // set. Per-user lists are small, so fetching full rows here is cheap and
    // worth the single-source-of-truth.
    return summarizeSessions(await this.listVisibleTo(viewerId, isAdmin));
  }

  async update(id: string, update: SessionUpdate): Promise<SessionTable | undefined> {
    await this.db.updateTable("sessions").set(update).where("id", "=", id).execute();
    return this.findById(id);
  }

  /**
   * Conditional {@link update}: applies the patch only while the row is still
   * `running`. Guards the auto-restart race where a terminate lands between
   * the spawn and the post-spawn patch — an unconditional update would flip a
   * terminated row back to alive and resurrect the session.
   * @returns the number of rows updated (0 = the row left `running` mid-flight)
   */
  async updateIfRunning(id: string, update: SessionUpdate): Promise<number> {
    const res = await this.db
      .updateTable("sessions")
      .set(update)
      .where("id", "=", id)
      .where("status", "=", "running")
      .executeTakeFirst();
    // Kysely types this as `numUpdated`, but kysely-bun-sqlite-dialect hands
    // back `numUpdatedRows` (a bigint) at runtime — read both so the guard
    // can never false-negative a real write into an orphan-cleanup.
    const counts = res as unknown as { numUpdated?: number | bigint; numUpdatedRows?: number | bigint };
    return Number(counts.numUpdatedRows ?? counts.numUpdated ?? 0);
  }

  /**
   * Conditional park for a manual restart: flip the row to the parked shape
   * (`running` / `alive: 0`) ONLY while it still sits in the state the restart
   * observed. A terminate that lands after that read moved `status`/`alive`,
   * so this no-ops (0 rows) and the restart backs off instead of resurrecting
   * a session the operator just killed — the invariant an unconditional write
   * would silently drop.
   * @returns rows updated (0 = the row changed under the restart)
   */
  async parkForRestart(
    id: string,
    expected: { status: SessionTable["status"]; alive: number },
    patch: SessionUpdate,
  ): Promise<number> {
    const res = await this.db
      .updateTable("sessions")
      .set(patch)
      .where("id", "=", id)
      .where("status", "=", expected.status)
      .where("alive", "=", expected.alive)
      .executeTakeFirst();
    const counts = res as unknown as { numUpdated?: number | bigint; numUpdatedRows?: number | bigint };
    return Number(counts.numUpdatedRows ?? counts.numUpdated ?? 0);
  }

  /** Lists all running sessions across users (reconciliation sweep). */
  async listRunning(): Promise<SessionTable[]> {
    return this.db.selectFrom("sessions").selectAll().where("status", "=", "running").execute();
  }

  /** Marks all running sessions for a user as terminated (e.g. tmux gone). */
  async markAllTerminated(userId: string, now: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ status: "terminated", endedAt: now })
      .where("userId", "=", userId)
      .where("status", "=", "running")
      .execute();
  }

  /** Marks a single session terminated regardless of current state. */
  async markTerminated(id: string, now: string): Promise<void> {
    await this.db.updateTable("sessions").set({ status: "terminated", endedAt: now }).where("id", "=", id).execute();
  }

  /** Keeps a session record alive in the DB (tmux still has it). */
  async markRunning(id: string): Promise<void> {
    await this.db.updateTable("sessions").set({ status: "running", endedAt: null }).where("id", "=", id).execute();
  }

  /** Permanently removes a session row. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("sessions").where("id", "=", id).execute();
  }
}
