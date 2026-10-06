import { type SqlBool, sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type {
  NewSshRuntimeSession,
  SshRuntimeSessionStatus,
  SshRuntimeSessionTable,
} from "@/db/types/ssh-runtime-sessions.db-types.js";

/**
 * Persistence for `ssh_runtime_sessions` (design 2026-10-05 §4, migration
 * 0049): the plane's session record. The in-memory registry owns the byte
 * channel; this table owns the history and the facts a restart must recover
 * from (which runtime node rows are hidden leftovers of dead sessions the
 * boot reconcile sweeps - see `session-settle.ts`).
 */
export class SshRuntimeSessionsRepository extends BaseRepository {
  async create(session: NewSshRuntimeSession): Promise<SshRuntimeSessionTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("sshRuntimeSessions")
      .values({
        ...session,
        status: session.status ?? "opening",
        helloJson: session.helloJson ?? null,
        createdAt: session.createdAt ?? now,
        lastSeenAt: null,
        closedAt: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<SshRuntimeSessionTable | undefined> {
    return await this.db.selectFrom("sshRuntimeSessions").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async listByOwner(ownerUserId: string): Promise<SshRuntimeSessionTable[]> {
    return await this.db
      .selectFrom("sshRuntimeSessions")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .orderBy("createdAt", "desc")
      .execute();
  }

  /** The status transition write; terminal states are final (a `lost` never re-opens - the registry is the only door, and it refuses a closed row). */
  async settle(id: string, status: SshRuntimeSessionStatus, helloJson: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .updateTable("sshRuntimeSessions")
      .set({
        status,
        ...(helloJson !== null ? { helloJson } : {}),
        lastSeenAt: now,
        ...(status === "lost" || status === "closed" ? { closedAt: now } : {}),
      })
      .where("id", "=", id)
      .where("status", "!=", "closed")
      .execute();
  }

  /** Heartbeat-ish stamp on any proof of life (the honest "last heard", not a poll). */
  async touch(id: string): Promise<void> {
    await this.db
      .updateTable("sshRuntimeSessions")
      .set({ lastSeenAt: new Date().toISOString() })
      .where("id", "=", id)
      .where("status", "in", ["opening", "active"])
      .execute();
  }

  /**
   * The hidden runtime node ids of the caller's SETTLED sessions (lost or
   * closed) on one destination - the candidates the reopen reconcile
   * (`session-adopt.ts`) sweeps pane rows off. The destination identity is
   * the same material the deterministic tmux socket hashes from
   * (host/port/user; the alias is display text and deliberately not part of
   * it - the same destination reached under two aliases is one destination),
   * and `user` matches with SQL `IS` so the "connecting account's default"
   * (null) equals itself.
   */
  async settledRuntimeNodeIdsForDestination(q: {
    ownerUserId: string;
    host: string;
    port: number;
    user: string | null;
  }): Promise<string[]> {
    const rows = await this.db
      .selectFrom("sshRuntimeSessions")
      .select("runtimeNodeId")
      .where("ownerUserId", "=", q.ownerUserId)
      .where("host", "=", q.host)
      .where("port", "=", q.port)
      // `IS` (not `=`): null must equal null here - a plain `=` would drop
      // every default-account destination out of the reconcile. Bound value,
      // never interpolated.
      .where(sql<SqlBool>`user IS ${q.user}`)
      .where("status", "in", ["lost", "closed"])
      .execute();
    return rows.map((r) => r.runtimeNodeId);
  }

  /** Active sessions brokered by one connecting node (the plane-side mirror of the node's own quota count). */
  async countActiveForNode(connectingNodeId: string): Promise<number> {
    const row = await this.db
      .selectFrom("sshRuntimeSessions")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("connectingNodeId", "=", connectingNodeId)
      .where("status", "in", ["opening", "active"])
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Boot sweep: `opening`/`active` rows with no live registry session (this
   * process just started) are `lost` - the child died with the old plane
   * process's broker link, exactly like the node-side supervisor's own boot
   * reconcile - and the hidden runtime node rows go offline with them. Panes
   * on those rows keep `status: running` with their `alive` left as found:
   * the design §6 unavailable reading comes from the offline node, and a
   * sweep must not rewrite pane outcomes it never witnessed. Never a
   * reconnect, never a replay.
   *
   * @returns the ids of the sessions swept (the service announces them)
   */
  async reconcileAtBoot(): Promise<string[]> {
    const stale = await this.db
      .selectFrom("sshRuntimeSessions")
      .select(["id", "runtimeNodeId"])
      .where("status", "in", ["opening", "active"])
      .execute();
    if (stale.length === 0) return [];
    const now = new Date().toISOString();
    await this.db
      .updateTable("sshRuntimeSessions")
      .set({ status: "lost", closedAt: now })
      .where(
        "id",
        "in",
        stale.map((r) => r.id),
      )
      .execute();
    await this.db
      .updateTable("nodes")
      .set({ status: "offline" })
      .where(
        "id",
        "in",
        stale.map((r) => r.runtimeNodeId),
      )
      .where("kind", "=", "runtime")
      .execute();
    return stale.map((r) => r.id);
  }
}
