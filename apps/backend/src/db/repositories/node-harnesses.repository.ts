import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NodeHarnessTable } from "@/db/types/node-harnesses.db-types.js";

/**
 * Per-agent-node harness enable/disable (spec §6.1): lazy rows — an absent
 * row means the plugin's `enabledByDefault`, same rule as
 * `harness-plugins.repository`. Only explicit user choices are written.
 */
export class NodeHarnessesRepository extends BaseRepository {
  /** Records an explicit enable/disable for one harness on one node (upsert). */
  async setEnabled(nodeId: string, harnessId: string, enabled: boolean): Promise<NodeHarnessTable> {
    return await this.db
      .insertInto("nodeHarnesses")
      .values({ nodeId, harnessId, enabled: enabled ? 1 : 0 })
      .onConflict((oc) => oc.columns(["nodeId", "harnessId"]).doUpdateSet({ enabled: enabled ? 1 : 0 }))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Explicitly-configured states only; callers merge plugin defaults.
   * @returns harness id → enabled, for every row that exists for this node
   */
  async enabledStates(nodeId: string): Promise<Map<string, boolean>> {
    const rows = await this.db.selectFrom("nodeHarnesses").selectAll().where("nodeId", "=", nodeId).execute();
    return new Map(rows.map((r) => [r.harnessId, r.enabled === 1]));
  }

  /** Drops every explicit state for a node (its delete path; FK cascade also covers it). */
  async clearForNode(nodeId: string): Promise<void> {
    await this.db.deleteFrom("nodeHarnesses").where("nodeId", "=", nodeId).execute();
  }
}
