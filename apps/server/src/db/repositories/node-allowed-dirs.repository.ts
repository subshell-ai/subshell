import { normalizeAllowedDirs } from "@internal/subshell-protocol";
import { BaseRepository } from "@/db/repositories/base.repository.js";

/**
 * A node's directory allowlist (spec 2026-09-05).
 *
 * Replace-whole-set semantics, mirroring
 * `SubshellSharesRepository.replaceForSubshell`: the API hands over the
 * complete intended list and this makes the table match it. No add/remove
 * endpoints — a partial update over a set that also lives on the node (pushed)
 * gives two places to drift.
 *
 * NO ROWS means UNRESTRICTED. Read {@link listForNode}'s note before writing a
 * caller that treats an empty array as "deny".
 *
 * **Paths arrive ALREADY RESOLVED on their node.** This class normalizes
 * (absolute, no `..`, no trailing slash) but cannot resolve symlinks — a rule
 * for an agent node names a path on a filesystem this process cannot see. The
 * PUT route does it, via the same `validateWorkingDir` the launch gate uses.
 * A caller that writes raw operator input here reintroduces the bug that
 * motivated it: a rule of `/tmp/work` never matches a candidate that
 * realpath'd to `/private/tmp/work`, so the owner is refused the directory
 * they just permitted.
 */
export class NodeAllowedDirsRepository extends BaseRepository {
  /**
   * The node's rules, sorted.
   *
   * @returns normalized absolute paths; **empty means the node is
   * unrestricted**, never "nothing is permitted". Every consumer
   * (`dirAllowed`, the node's own check, the UI's empty state) reads it that
   * way, and inverting it anywhere would silently lock an instance out of its
   * own nodes on upgrade.
   */
  async listForNode(nodeId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("nodeAllowedDirs")
      .select("path")
      .where("nodeId", "=", nodeId)
      .orderBy("path", "asc")
      .execute();
    return rows.map((row) => row.path);
  }

  /** The rules for several nodes at once, for list views. */
  async listForNodes(nodeIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
    if (nodeIds.length === 0) return map;
    const rows = await this.db
      .selectFrom("nodeAllowedDirs")
      .select(["nodeId", "path"])
      .where("nodeId", "in", nodeIds)
      .orderBy("path", "asc")
      .execute();
    for (const row of rows) map.get(row.nodeId)?.push(row.path);
    return map;
  }

  /**
   * Overwrites the node's whole rule set with `dirs`.
   *
   * Normalizes first (dropping invalid entries, redundant nesting and
   * duplicates), then delete-then-insert inside ONE transaction so a smaller
   * new set leaves nothing stale and a failure part-way cannot leave a node
   * with half a policy — which, for an allowlist, would mean a policy nobody
   * chose.
   *
   * @returns the rules as now stored
   */
  async replaceForNode(nodeId: string, dirs: readonly string[]): Promise<string[]> {
    const normalized = normalizeAllowedDirs(dirs);
    const createdAt = new Date().toISOString();
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("nodeAllowedDirs").where("nodeId", "=", nodeId).execute();
      if (normalized.length > 0) {
        await trx
          .insertInto("nodeAllowedDirs")
          .values(normalized.map((path) => ({ id: crypto.randomUUID(), nodeId, path, createdAt })))
          .execute();
      }
    });
    return normalized;
  }

  /** Drops every rule for a node (its delete path; the FK cascade also covers it). */
  async clearForNode(nodeId: string): Promise<void> {
    await this.db.deleteFrom("nodeAllowedDirs").where("nodeId", "=", nodeId).execute();
  }
}
