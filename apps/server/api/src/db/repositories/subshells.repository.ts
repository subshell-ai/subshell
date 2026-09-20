import { BaseRepository } from "@/db/repositories/base.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { NewSubshell, SubshellTable, SubshellUpdate } from "@/db/types/subshells.db-types.js";
import { publishLive } from "@/services/live-bus.js";

/** The four fields {@link summarizeSubshells} reads off a subshell row. */
type SummarizableSubshell = Pick<SubshellTable, "status" | "alive" | "waitingSince" | "nodeId">;

/**
 * The badge counts derived from a set of subshell rows: `waiting` is the
 * ratified formula (status='running' AND alive=1 AND waiting_since IS NOT
 * NULL) MINUS rows whose launch node is unreachable (spec §5.6 — a waiting
 * prompt behind a dead socket is nobody's badge; only `waiting` shrinks,
 * `running` and `total` deliberately stay last-known-truth counts, the
 * `running` liveness question is not taken up here); `running` counts alive
 * rows only. Plain row-scan, not SQL aggregates: per-user subshell lists are
 * small on a local instance, and keeping the predicate in one readable place
 * beats three COUNT subqueries.
 *
 * `isNodeOffline` is INJECTED, never imported: the repository must not reach
 * into the services layer (dependency direction). The blessed implementation
 * is `node-registry.isNodeOffline`. The default counts as if every node were
 * reachable — callers owning a badge surface MUST pass the predicate.
 *
 * Exported so both the owner-only {@link SubshellsRepository.countsByUser} and
 * the sharing-aware visible summary reduce over the SAME formula (single source
 * of truth — they must never drift).
 */
export function summarizeSubshells(
  rows: SummarizableSubshell[],
  isNodeOffline: (nodeId: string) => boolean = () => false,
): { total: number; running: number; waiting: number } {
  let running = 0;
  let waiting = 0;
  for (const r of rows) {
    const alive = r.status === "running" && r.alive === 1;
    if (alive) running += 1;
    if (alive && r.waitingSince != null && !isNodeOffline(r.nodeId)) waiting += 1;
  }
  return { total: rows.length, running, waiting };
}

/**
 * Repository for agent subshells.
 * DB rows are a record of intent; liveness comes from the tmux runner.
 */
export class SubshellsRepository extends BaseRepository {
  async create(subshell: NewSubshell): Promise<SubshellTable> {
    return this.db
      .insertInto("subshells")
      .values({
        ...subshell,
        // Liveness/auto-restart columns default in the DB (migration 0003);
        // mirror those defaults here so the row is complete on read-back.
        alive: subshell.alive ?? 1,
        backoffCount: subshell.backoffCount ?? 0,
        restartOnExit: subshell.restartOnExit ?? 0,
        nameLocked: subshell.nameLocked ?? 0,
        notify: subshell.notify ?? 0,
        waitingSince: subshell.waitingSince ?? null,
        status: subshell.status ?? "running",
        // A presetless launch is a real launch (spec 2026-09-13): null is the
        // column's own default, mirrored so the typed insert is complete.
        presetId: subshell.presetId ?? null,
        // Node pin defaults in the DB (migration 0017); mirror it so the typed
        // insert is complete and the row reads back whole.
        nodeId: subshell.nodeId ?? LOCAL_NODE_ID,
        createdAt: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .then(announce);
  }

  async findById(id: string): Promise<SubshellTable | undefined> {
    return this.db.selectFrom("subshells").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Lists subshells by owner, newest first. */
  async listByUser(userId: string, status?: SubshellTable["status"]): Promise<SubshellTable[]> {
    let query = this.db.selectFrom("subshells").selectAll().where("userId", "=", userId).orderBy("createdAt", "desc");
    if (status) query = query.where("status", "=", status);
    return query.execute();
  }

  /**
   * Subshells a viewer may SEE (spec 2026-08-31 §4.3): their own, plus any
   * shared with Everyone (a `subshell_shares` row with a NULL grantee) or named
   * directly, newest first. An admin sees every subshell. A private foreign
   * subshell never appears — the whole list reads as "no such subshell", so a
   * stranger cannot probe which ids exist.
   *
   * This is the WHERE-clause half of visibility; the resolver
   * (`lib/subshell-access`) is the access-level half. Both key off the same
   * `granteeUserId IS NULL OR = viewer` rule.
   */
  async listVisibleTo(viewerId: string, isAdmin: boolean, status?: SubshellTable["status"]): Promise<SubshellTable[]> {
    let query = this.db.selectFrom("subshells");
    if (!isAdmin) {
      query = query.where((eb) =>
        eb.or([
          eb("subshells.userId", "=", viewerId),
          eb.exists(
            eb
              .selectFrom("subshellShares")
              .whereRef("subshellShares.subshellId", "=", "subshells.id")
              .where((e) =>
                e.or([e("subshellShares.granteeUserId", "is", null), e("subshellShares.granteeUserId", "=", viewerId)]),
              )
              .select("subshellShares.subshellId"),
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
   * {@link summarizeSubshells}. Badge surfaces (push payloads) MUST pass the
   * blessed `node-registry.isNodeOffline` so a waiting prompt behind a dead
   * node socket does not light up the badge.
   * @param userId - Owner whose subshells are counted
   * @param isNodeOffline - Injected liveness predicate (see {@link summarizeSubshells})
   * @returns `{ total, running, waiting }`
   */
  async countsByUser(
    userId: string,
    isNodeOffline: (nodeId: string) => boolean,
  ): Promise<{ total: number; running: number; waiting: number }> {
    const rows = await this.db
      .selectFrom("subshells")
      .select(["status", "alive", "waitingSince", "nodeId"])
      .where("userId", "=", userId)
      .execute();
    return summarizeSubshells(rows, isNodeOffline);
  }

  /**
   * Badge counts over everything a viewer can SEE (own + shared; all for an
   * admin) — the same visible set {@link listVisibleTo} returns, reduced with
   * the shared {@link summarizeSubshells} formula. Badge surfaces MUST pass
   * the blessed `node-registry.isNodeOffline` (see {@link summarizeSubshells}
   * for what the predicate does to each count).
   */
  async countsVisibleTo(
    viewerId: string,
    isAdmin: boolean,
    isNodeOffline: (nodeId: string) => boolean,
  ): Promise<{ total: number; running: number; waiting: number }> {
    // Delegates to listVisibleTo so there is exactly ONE definition of
    // "what a viewer can see" — counts and list can never disagree about the
    // set. Per-user lists are small, so fetching full rows here is cheap and
    // worth the single-source-of-truth.
    return summarizeSubshells(await this.listVisibleTo(viewerId, isAdmin), isNodeOffline);
  }

  async update(id: string, update: SubshellUpdate): Promise<SubshellTable | undefined> {
    await this.db.updateTable("subshells").set(update).where("id", "=", id).execute();
    const row = await this.findById(id);
    if (row) announce(row);
    return row;
  }

  /**
   * Conditional {@link update}: applies the patch only while the row is still
   * `running`. Guards the auto-restart race where a terminate lands between
   * the spawn and the post-spawn patch — an unconditional update would flip a
   * terminated row back to alive and resurrect the subshell.
   * @returns the number of rows updated (0 = the row left `running` mid-flight)
   */
  async updateIfRunning(id: string, update: SubshellUpdate): Promise<number> {
    const res = await this.db
      .updateTable("subshells")
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
   * CLAIM the alive→dead transition: applies the patch only while the row is
   * still a LIVE running one, and answers whether this caller is the one that
   * moved it.
   *
   * Two independent paths retire a live pane and each owes its owner exactly
   * one notification — the death the agent reports as an `exit`, and the
   * maintenance window that killed it — so "did I stop this" cannot be a read
   * followed by a write: both would read `alive: 1`, both would write, and the
   * owner gets told twice about one death. A single conditional statement is
   * the only thing that can decide it, and losing it is the caller's cue to
   * stay silent.
   *
   * The predicate is `alive` ALONE — a caller that also cares about `status`
   * has already checked it (and a row that reached `terminated` had its
   * `alive` cleared in the same act, so the two can only disagree on a row
   * nothing in this codebase writes).
   *
   * @returns rows updated — 1 for the caller that performed the transition, 0
   *   for everyone who arrived after it
   */
  async updateIfAlive(id: string, update: SubshellUpdate): Promise<number> {
    const res = await this.db
      .updateTable("subshells")
      .set(update)
      .where("id", "=", id)
      .where("alive", "=", 1)
      .executeTakeFirst();
    const counts = res as unknown as { numUpdated?: number | bigint; numUpdatedRows?: number | bigint };
    return Number(counts.numUpdatedRows ?? counts.numUpdated ?? 0);
  }

  /**
   * Conditional park for a manual restart: flip the row to the parked shape
   * (`running` / `alive: 0`) ONLY while it still sits in the state the restart
   * observed. A terminate that lands after that read moved `status`/`alive`,
   * so this no-ops (0 rows) and the restart backs off instead of resurrecting
   * a subshell the operator just killed — the invariant an unconditional write
   * would silently drop.
   * @returns rows updated (0 = the row changed under the restart)
   */
  async parkForRestart(
    id: string,
    expected: { status: SubshellTable["status"]; alive: number },
    patch: SubshellUpdate,
  ): Promise<number> {
    const res = await this.db
      .updateTable("subshells")
      .set(patch)
      .where("id", "=", id)
      .where("status", "=", expected.status)
      .where("alive", "=", expected.alive)
      .executeTakeFirst();
    const counts = res as unknown as { numUpdated?: number | bigint; numUpdatedRows?: number | bigint };
    return Number(counts.numUpdatedRows ?? counts.numUpdated ?? 0);
  }

  /** Lists all running subshells across users (reconciliation sweep). */
  async listRunning(): Promise<SubshellTable[]> {
    return this.db.selectFrom("subshells").selectAll().where("status", "=", "running").execute();
  }

  /**
   * How many RUNNING subshells of one harness the instance holds (the
   * uninstall impact read — "1 has a running subshell"). Instance-wide like
   * {@link listRunning}: the blast radius of an instance uninstall spans
   * every user. Terminated rows never count.
   */
  async countRunningByHarness(harnessId: string): Promise<number> {
    const row = await this.db
      .selectFrom("subshells")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "=", "running")
      .where("harnessId", "=", harnessId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Marks all running subshells for a user as terminated (e.g. tmux gone). */
  async markAllTerminated(userId: string, now: string): Promise<void> {
    // Ids are read FIRST: after the update these rows no longer match the
    // predicate, so there would be nothing left to name in the events.
    const affected = await this.db
      .selectFrom("subshells")
      .select("id")
      .where("userId", "=", userId)
      .where("status", "=", "running")
      .execute();
    await this.db
      .updateTable("subshells")
      .set({ status: "terminated", endedAt: now })
      .where("userId", "=", userId)
      .where("status", "=", "running")
      .execute();
    for (const { id } of affected) publishLive({ kind: "subshell.changed", id });
  }

  /** Marks a single subshell terminated regardless of current state. */
  async markTerminated(id: string, now: string): Promise<void> {
    await this.db.updateTable("subshells").set({ status: "terminated", endedAt: now }).where("id", "=", id).execute();
    publishLive({ kind: "subshell.changed", id });
  }

  /** Keeps a subshell record alive in the DB (tmux still has it). */
  async markRunning(id: string): Promise<void> {
    await this.db.updateTable("subshells").set({ status: "running", endedAt: null }).where("id", "=", id).execute();
    publishLive({ kind: "subshell.changed", id });
  }

  /** Permanently removes a subshell row. */
  async delete(id: string): Promise<void> {
    // The owner is read BEFORE the delete: the live event carries it because
    // nothing can look it up afterwards, and without an owner there is no
    // recipient set to publish the removal to (spec 2026-09-19 §4.1a).
    const row = await this.findById(id);
    await this.db.deleteFrom("subshells").where("id", "=", id).execute();
    if (row) publishLive({ kind: "subshell.deleted", id, ownerId: row.userId });
  }
}

/**
 * Announces a row's change on the live bus and returns it unchanged.
 *
 * **Every subshell write in the app goes through this repository** — the
 * services, the reconcile sweep and the idle watcher all call it directly —
 * so this is the one layer where no mutation site can be forgotten. Emitting
 * from the services instead would have missed the sweep, which is the writer
 * of `alive`, `startedAt` and `lastOutputAt`.
 *
 * Safe against a rollback because there are none: no subshell write runs
 * inside a transaction. If one is ever added, the publish must move to after
 * the commit.
 */
function announce(row: SubshellTable): SubshellTable {
  publishLive({ kind: "subshell.changed", id: row.id });
  return row;
}
