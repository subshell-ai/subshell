import type { SshRunFactsWire } from "@internal/subshell-protocol";
import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewSshRun, SshRunTable } from "@/db/types/ssh-runs.db-types.js";

/**
 * Persistence for `ssh_runs` (Gate A §4): the plane's mirror of a run whose
 * truth (output, process supervision) lives on the connecting runtime. The
 * row doubles as the durable-dispatch dedup record — the server-allocated id
 * plus `request_digest` — and it OUTLIVES output and even its connection and
 * node (SET NULL columns), so "deleting output must not delete replay
 * protection" holds even after the retention sweep trimmed everything else.
 *
 * `applyFacts` is the settle write every node answer funnels through: one
 * statement, monotone fields only ever move forward (a `running` observation
 * never re-clears `started_at`; a terminal state is final), because answers
 * can arrive out of order across a reconnect and the honest merge is a
 * reducer, not a last-writer-wins.
 */
export class SshRunsRepository extends BaseRepository {
  async create(run: NewSshRun): Promise<SshRunTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("sshRuns")
      .values({ ...run, createdAt: now, updatedAt: now })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<SshRunTable | undefined> {
    return this.db.selectFrom("sshRuns").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** The owner's recent runs, newest first (the list tail is bounded by the caller). */
  async listRecentByOwner(userId: string, limit: number): Promise<SshRunTable[]> {
    return this.db
      .selectFrom("sshRuns")
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();
  }

  /**
   * Runs INITIATED BY ONE CREDENTIAL under one grant, newest first - the
   * granted pane's recovery list. Matching on `apiKeyId` (the dispatch-time
   * key) rather than the grant id is deliberate: the grant row can cascade
   * with the pane, the credential fact is the honest "its own runs" test.
   */
  async listRecentByCredential(apiKeyId: string, limit: number): Promise<SshRunTable[]> {
    return this.db
      .selectFrom("sshRuns")
      .selectAll()
      .where("apiKeyId", "=", apiKeyId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();
  }

  /** Active (`accepted`/`running`) runs for one owner on one node - the per-owner quota count. */
  async countActiveForOwnerNode(userId: string, nodeId: string): Promise<number> {
    const row = await this.db
      .selectFrom("sshRuns")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("userId", "=", userId)
      .where("nodeId", "=", nodeId)
      .where("status", "in", ["accepted", "running"])
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** Active runs on one node across ALL owners - the node-wide quota count. */
  async countActiveForNode(nodeId: string): Promise<number> {
    const row = await this.db
      .selectFrom("sshRuns")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("nodeId", "=", nodeId)
      .where("status", "in", ["accepted", "running"])
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** True when the connection has work the refuse-edit/delete rule counts: an active run or a live managed pane. */
  async hasActiveWork(connectionId: string): Promise<boolean> {
    const run = await this.db
      .selectFrom("sshRuns")
      .select("id")
      .where("connectionId", "=", connectionId)
      .where("status", "in", ["accepted", "running"])
      .limit(1)
      .executeTakeFirst();
    if (run) return true;
    const pane = await this.db
      .selectFrom("sshPanes")
      .innerJoin("subshells", "subshells.id", "sshPanes.subshellId")
      .select("sshPanes.subshellId")
      .where("sshPanes.connectionId", "=", connectionId)
      .where("subshells.status", "=", "running")
      .where("subshells.alive", "=", 1)
      .limit(1)
      .executeTakeFirst();
    return pane !== undefined;
  }

  /**
   * Active runs initiated under ONE grant - the revocation sweep (spec §2:
   * cancel the runs/terminals initiated under that grant, never a human's or
   * another grant's). Matching on BOTH `grantId` and `apiKeyId`: the durable
   * credential fact survives a grant-row cascade, and an equal id alone would
   * already have been scoped to the credential at dispatch.
   */
  async listActiveForGrant(grantId: string, apiKeyId: string): Promise<SshRunTable[]> {
    return this.db
      .selectFrom("sshRuns")
      .selectAll()
      .where("grantId", "=", grantId)
      .where("apiKeyId", "=", apiKeyId)
      .where("status", "in", ["accepted", "running"])
      .execute();
  }

  /**
   * Cancellation requested but not yet confirmed LOCAL, on one node - the
   * reconnect pass dispatches these BEFORE new work (spec §2's offline
   * cancellation rule). Includes runs the node has never seen settled; the
   * reconcile pass re-asks them all.
   */
  async listPendingCancelsForNode(nodeId: string): Promise<SshRunTable[]> {
    return this.db
      .selectFrom("sshRuns")
      .selectAll()
      .where("nodeId", "=", nodeId)
      .where("status", "in", ["accepted", "running"])
      .where("cancelRequested", "=", 1)
      .where("cancelLocalConfirmed", "=", 0)
      .execute();
  }

  /**
   * Unsettled runs whose NODE row was deleted (the SET NULL column is the
   * orphan fact: dispatch always writes a non-null node). The retention pass
   * settles these to `unknown` - the machine that answers for them is gone.
   */
  async listOrphans(): Promise<SshRunTable[]> {
    return this.db
      .selectFrom("sshRuns")
      .selectAll()
      .where("nodeId", "is", null)
      .where("status", "in", ["accepted", "running"])
      .execute();
  }

  /** Non-terminal runs on one node - the reconcile-on-reconnect census. */
  async listUnsettledForNode(nodeId: string): Promise<SshRunTable[]> {
    return this.db
      .selectFrom("sshRuns")
      .selectAll()
      .where("nodeId", "=", nodeId)
      .where("status", "in", ["accepted", "running"])
      .execute();
  }

  /**
   * Fold a node {@link SshRunFactsWire} answer into the mirror (monotone; see
   * class doc). `startedAt`/`finishedAt` ride the server clock at first
   * observation - the node's answer carries no timestamps in the frozen wire
   * shape, so "when the PLANE learned it" is the honest stamp.
   */
  async applyFacts(id: string, facts: SshRunFactsWire): Promise<void> {
    const terminal = facts.lifecycle === "completed" || facts.lifecycle === "unknown";
    const now = new Date().toISOString();
    await this.db
      .updateTable("sshRuns")
      .set({
        // A terminal lifecycle is final: a late answer that still says
        // `running` (reconnect replay, an out-of-order window) must never
        // resurrect a settled run. Non-terminal facts keep flowing.
        status: sql`CASE WHEN status IN ('completed', 'unknown') THEN status ELSE ${facts.lifecycle} END`,
        cancelRequested: facts.cancelRequested ? 1 : sql`cancel_requested`,
        cancelLocalConfirmed: facts.cancelLocalConfirmed ? 1 : sql`cancel_local_confirmed`,
        deadlineHit: facts.deadlineHit ? 1 : sql`deadline_hit`,
        remoteStatus: facts.remoteStatus ?? sql`remote_status`,
        remoteStatusConfirmed: facts.remoteStatusConfirmed ? 1 : sql`remote_status_confirmed`,
        localExitCode: facts.localExitCode ?? sql`local_exit_code`,
        localExitSignal: facts.localExitSignal ?? sql`local_exit_signal`,
        startedAt: sql`COALESCE(started_at, CASE WHEN ${terminal || facts.lifecycle === "running" ? 1 : 0} = 1 THEN ${now} ELSE NULL END)`,
        finishedAt: terminal ? sql`COALESCE(finished_at, ${now})` : sql`finished_at`,
        updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Roll back a row whose dispatch the node REFUSED before acceptance: the
   * run exists nowhere, and a mirror claiming `accepted` would lie. Guarded
   * on the never-moved state so a concurrent settle (a reconcile answer
   * landing between dispatch and rollback) is never overwritten by the
   * rollback of a dispatch that in fact produced state.
   */
  async deleteIfUntouched(id: string): Promise<void> {
    await this.db
      .deleteFrom("sshRuns")
      .where("id", "=", id)
      .where("status", "=", "accepted")
      .where("startedAt", "is", null)
      .where("finishedAt", "is", null)
      .execute();
  }

  /** Record a cancellation REQUEST locally (the dispatch attempt is the caller's best-effort follow). */
  async markCancelRequested(id: string): Promise<void> {
    await this.db
      .updateTable("sshRuns")
      .set({ cancelRequested: 1, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Retention sweep: delete completed/unknown run METADATA older than the
   * window (`finishedAt` past it). Active rows are never candidates - the
   * predicate spells `status` terminal, mirroring pane-log hygiene's
   * "running logs are never swept". Returns how many rows went.
   */
  async deleteCompletedBefore(cutoffIso: string): Promise<number> {
    const rows = await this.db
      .selectFrom("sshRuns")
      .select("id")
      .where("status", "in", ["completed", "unknown"])
      .where((eb) =>
        eb.or([
          eb.and([eb("finishedAt", "is not", null), eb("finishedAt", "<", cutoffIso)]),
          eb.and([eb("finishedAt", "is", null), eb("updatedAt", "<", cutoffIso)]),
        ]),
      )
      .execute();
    if (rows.length === 0) return 0;
    await this.db
      .deleteFrom("sshRuns")
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    return rows.length;
  }
}
