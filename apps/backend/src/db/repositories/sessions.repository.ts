import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewSession, SessionTable, SessionUpdate } from "@/db/types/sessions.db-types.js";

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
