import { BaseRepository } from "@/db/repositories/base.repository.js";

/**
 * Instance-wide inventory counts for the admin status page.
 *
 * Deliberately ONE repository crossing several tables rather than a
 * `countInstance()` bolted onto each of six existing ones: every other
 * repository here is scoped to an owner, a node, a workspace or a channel —
 * that scoping is the point of them, and it is what keeps a caller from
 * forgetting it. An unscoped total is a different concern with a single
 * consumer, so it lives in one place where "this reads across everything, and
 * only an admin may see it" is stated once.
 *
 * Every query is a bare `COUNT(*)`. On a local SQLite instance these tables
 * are small — the largest realistic one is `subshells`, in the hundreds — so
 * no index is added for them; if this ever pages or windows by time, that
 * calculus changes.
 */
export class InstanceStatsRepository extends BaseRepository {
  /**
   * Rows in one table, optionally narrowed to running subshells etc. Private
   * because the public surface is the whole snapshot: a caller that could ask
   * for counts one at a time would fan out N round-trips for one page.
   */
  private async countOf(table: "subshells" | "nodes" | "workspaces" | "channels" | "presets"): Promise<number> {
    const row = await this.db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * The seeded `local` rows — in practice one, the control-plane host itself.
   *
   * Counted rather than assumed to be 1: the number is added to a live count
   * of connected agents, and a hard-coded constant would report an online node
   * on an instance whose `local` row had never been seeded.
   */
  private async countLocalNodes(): Promise<number> {
    const row = await this.db
      .selectFrom("nodes")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("kind", "=", "local")
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Subshells that have not ended — the "running right now" figure. */
  private async countRunningSubshells(): Promise<number> {
    const row = await this.db
      .selectFrom("subshells")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("status", "=", "running")
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Users by role, in ONE grouped pass. `user_meta` holds one row per user, so
   * the total here is the roster size; a user whose meta row is somehow absent
   * would be under-counted, which is the same basis every other role check in
   * the app already uses.
   */
  private async countUsersByRole(): Promise<{ total: number; admins: number }> {
    const rows = await this.db
      .selectFrom("userMeta")
      .select(["role", (eb) => eb.fn.countAll().as("count")])
      .groupBy("role")
      .execute();
    let total = 0;
    let admins = 0;
    for (const row of rows) {
      const n = Number(row.count);
      total += n;
      if (row.role === "admin") admins += n;
    }
    return { total, admins };
  }

  /**
   * Every ENROLLED agent's last-known version, for the compatibility check.
   *
   * `local` is excluded: the control-plane host is a node row for launching
   * purposes but runs no agent, so it has no version to be behind. The value
   * is LAST-KNOWN rather than live — it is written on enroll and on every
   * `ready`, and deliberately never cleared when a node goes offline, so an
   * agent that is too old to connect at all still reports the version that
   * got it refused. That is exactly the case an admin needs to see.
   */
  async agentVersions(): Promise<{ id: string; name: string; agentVersion: string | null }[]> {
    return this.db
      .selectFrom("nodes")
      .select(["id", "name", "agentVersion"])
      .where("kind", "=", "agent")
      .orderBy("name")
      .execute();
  }

  /**
   * The whole inventory in one call. Issued concurrently — these are
   * independent reads against one local SQLite file, and serializing eight
   * round-trips to render one page would be the only slow thing about it.
   */
  async snapshot(): Promise<{
    /** Registered users, and how many of them are admins */
    users: { total: number; admins: number };
    /** Subshells ever created, and those currently running */
    subshells: { total: number; running: number };
    /** Node rows: every one of them, and how many are the seeded `local` kind */
    nodes: { total: number; local: number };
    /** Workspaces across all users */
    workspaces: number;
    /** Cross-subshell channels */
    channels: number;
    /** Harness presets across all users */
    presets: number;
  }> {
    const [users, subshells, running, nodes, localNodes, workspaces, channels, presets] = await Promise.all([
      this.countUsersByRole(),
      this.countOf("subshells"),
      this.countRunningSubshells(),
      this.countOf("nodes"),
      this.countLocalNodes(),
      this.countOf("workspaces"),
      this.countOf("channels"),
      this.countOf("presets"),
    ]);
    return {
      users,
      subshells: { total: subshells, running },
      nodes: { total: nodes, local: localNodes },
      workspaces,
      channels,
      presets,
    };
  }
}
