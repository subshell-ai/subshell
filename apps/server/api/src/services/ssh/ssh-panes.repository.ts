import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewSshPane, SshPaneTable } from "@/db/types/ssh-panes.db-types.js";

/**
 * Persistence for `ssh_panes` (Gate A §4) - the managed-terminal marker whose
 * PRESENCE is the pane-surface gate's whole question ("does this pane have a
 * managed row: one primary-key read on the hottest path in the feature"), and
 * whose control columns the takeover/return transitions move.
 */
export class SshPanesRepository extends BaseRepository {
  async create(pane: NewSshPane): Promise<SshPaneTable> {
    return this.db
      .insertInto("sshPanes")
      .values({ ...pane, createdAt: pane.createdAt ?? sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** THE hot read: one managed pane by its subshell id (no row ⇒ unmanaged ⇒ policy n/a). */
  async findBySubshell(subshellId: string): Promise<SshPaneTable | undefined> {
    return this.db.selectFrom("sshPanes").selectAll().where("subshellId", "=", subshellId).executeTakeFirst();
  }

  /** Managed panes on a connection at a revision (refuse-edit census; revocation sweep). */
  async listByConnection(connectionId: string): Promise<SshPaneTable[]> {
    return this.db.selectFrom("sshPanes").selectAll().where("connectionId", "=", connectionId).execute();
  }

  /**
   * Live managed terminals an owner holds on one node - the terminal-quota
   * count. "Live" is the subshell row's two facts (status running AND alive),
   * the same RUNNING posture every pane surface uses: a parked alive-0 row is
   * a dead ssh and must not hold a quota slot forever.
   */
  async countLiveForOwnerNode(userId: string, nodeId: string): Promise<number> {
    const row = await this.db
      .selectFrom("sshPanes")
      .innerJoin("subshells", "subshells.id", "sshPanes.subshellId")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("subshells.userId", "=", userId)
      .where("subshells.nodeId", "=", nodeId)
      .where("subshells.status", "=", "running")
      .where("subshells.alive", "=", 1)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** Managed panes whose ordinary row is RUNNING on one node (the reconnect re-assert pass). */
  async listByNodeLive(nodeId: string): Promise<SshPaneTable[]> {
    return this.db
      .selectFrom("sshPanes")
      .innerJoin("subshells", "subshells.id", "sshPanes.subshellId")
      .selectAll("sshPanes")
      .where("subshells.nodeId", "=", nodeId)
      .where("subshells.status", "=", "running")
      .where("subshells.alive", "=", 1)
      .execute();
  }

  /**
   * Move the input-control state of a managed pane. The generation is RAISED
   * by exactly one (the plane's counter, mirrored node-side by
   * `ssh_input_control`), never chosen by a caller - `ssh-api-types.ts`:
   * "the generation is the server's to raise, never the caller's to choose".
   */
  async setControl(subshellId: string, controlOwner: SshPaneTable["controlOwner"]): Promise<SshPaneTable | undefined> {
    await this.db
      .updateTable("sshPanes")
      .set({ controlOwner, controlGeneration: sql`control_generation + 1` })
      .where("subshellId", "=", subshellId)
      .execute();
    return this.findBySubshell(subshellId);
  }
}
