import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewNode, NodeStatus, NodeTable } from "@/db/types/nodes.db-types.js";

/** Fields a `ready` frame carries about the machine behind a node (spec §5.3). */
export type NodeReadyReport = {
  /** mote-agent version reported by the agent */
  agentVersion: string;
  /** node protocol version reported by the agent */
  protocolVersion: number;
  /** OS reported by the agent ('linux' | 'darwin' | …) */
  os: string;
  /** CPU arch reported by the agent ('x64' | 'arm64' | …) */
  arch: string;
  /** Hostname reported by the agent */
  hostname: string;
  /** Capability strings (persisted as a JSON array) */
  capabilities: string[];
};

/**
 * Repository for the node registry (spec 2026-08-31 §6.1): one row per
 * machine — the control-plane host (`id: 'local'`) and enrolled agent nodes.
 * This only reads and writes rows; authorization is decided by the
 * node-access resolver (phase 1).
 */
export class NodesRepository extends BaseRepository {
  /** Inserts a node row, mirroring the DB defaults so the read-back is complete. */
  async create(input: NewNode): Promise<NodeTable> {
    const now = new Date().toISOString();
    return await this.db
      .insertInto("nodes")
      .values({
        id: input.id,
        ownerUserId: input.ownerUserId,
        name: input.name,
        kind: input.kind,
        // Everything machine-reported starts NULL/offline until `ready` lands
        // (migration 0017 defaults); mirror them so the typed insert is complete.
        os: input.os ?? null,
        arch: input.arch ?? null,
        hostname: input.hostname ?? null,
        status: input.status ?? "offline",
        lastSeenAt: input.lastSeenAt ?? null,
        agentVersion: input.agentVersion ?? null,
        protocolVersion: input.protocolVersion ?? null,
        publicKey: input.publicKey ?? null,
        apiKeyId: input.apiKeyId ?? null,
        capabilities: input.capabilities ?? null,
        inventoryJson: input.inventoryJson ?? null,
        inventoryAt: input.inventoryAt ?? null,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** One node by id, or undefined (ids are never probed across owners — callers gate). */
  async findById(id: string): Promise<NodeTable | undefined> {
    return await this.db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Nodes a viewer may SEE: owned or shared — including 'local' via its
   * Everyone/edit share. There is no separate local visibility switch
   * (spec 2026-08-31 §2): a private foreign node never appears and ids
   * cannot be probed, and revoking local's share revokes its visibility.
   * Phase truth: the `local` row and that Everyone/edit share are SEEDED AT
   * PHASE-1 BOOT (`ensureLocalNode`, phase 1A) — in phase 0 this query simply
   * returns owned/explicitly-shared agent rows (there are none yet).
   * @param viewerUserId - The user whose grants and ownership decide visibility
   */
  async findAccessible(viewerUserId: string): Promise<NodeTable[]> {
    return await this.db
      .selectFrom("nodes")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("ownerUserId", "=", viewerUserId),
          eb.exists(
            eb
              .selectFrom("nodeShares")
              .whereRef("nodeShares.nodeId", "=", "nodes.id")
              .where((e) =>
                e.or([e("nodeShares.granteeUserId", "is", null), e("nodeShares.granteeUserId", "=", viewerUserId)]),
              )
              .select("nodeShares.id"),
          ),
        ]),
      )
      .orderBy("createdAt", "asc")
      .execute();
  }

  /** Every node one user owns, creation order. */
  async listByOwner(ownerUserId: string): Promise<NodeTable[]> {
    return await this.db.selectFrom("nodes").selectAll().where("ownerUserId", "=", ownerUserId).execute();
  }

  /** Renames a node (the name is what the picker shows). */
  async rename(id: string, name: string): Promise<NodeTable | undefined> {
    return await this.db
      .updateTable("nodes")
      .set({ name, updatedAt: new Date().toISOString() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Apply a `ready` frame (spec §5.3): machine identity + capabilities
   * (JSON-encoded) + online + last-seen, in one write.
   */
  async applyReady(id: string, r: NodeReadyReport): Promise<NodeTable | undefined> {
    const now = new Date().toISOString();
    return await this.db
      .updateTable("nodes")
      .set({
        agentVersion: r.agentVersion,
        protocolVersion: r.protocolVersion,
        os: r.os,
        arch: r.arch,
        hostname: r.hostname,
        capabilities: JSON.stringify(r.capabilities),
        status: "online",
        lastSeenAt: now,
        updatedAt: now,
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Cache a harness inventory snapshot (spec §6.2 TTL is the caller's). */
  async applyInventory(id: string, inventoryJson: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .updateTable("nodes")
      .set({ inventoryJson, inventoryAt: now, updatedAt: now })
      .where("id", "=", id)
      .execute();
  }

  /** Persist the status projection (the live socket stays authoritative). */
  async setStatus(id: string, status: NodeStatus): Promise<void> {
    await this.db
      .updateTable("nodes")
      .set({ status, updatedAt: new Date().toISOString() })
      .where("id", "=", id)
      .execute();
  }

  /** Bump `lastSeenAt` on a heartbeat without touching anything else. */
  async touch(id: string): Promise<void> {
    await this.db.updateTable("nodes").set({ lastSeenAt: new Date().toISOString() }).where("id", "=", id).execute();
  }

  /**
   * Offline sweep (spec 2026-08-31 §5.3): flip agent nodes that stopped
   * reporting from `online` to `offline`. A row is stale when its last
   * heartbeat/ready predates `olderThanIso` OR was never stamped (crash
   * between socket-open and first frame). `local` is excluded by `kind` —
   * the control-plane host has no agent socket and no heartbeat stream.
   * @param olderThanIso - ISO 8601 cutoff; `lastSeenAt` strictly before it is stale
   * @param excludeNodeIds - ids to spare regardless of staleness — the caller
   * passes the LIVE-socket registry's ids so a heartbeat-stalled but
   * socket-connected node keeps its `online` projection (the repository stays
   * registry-agnostic; the wiring layer decides who is exempt). Empty/omitted
   * means no exclusion — the clause is skipped rather than rendered as
   * `not in ()`.
   * @returns the number of rows flipped
   */
  async markStaleAgentsOffline(olderThanIso: string, excludeNodeIds?: string[]): Promise<number> {
    let query = this.db
      .updateTable("nodes")
      .set({ status: "offline", updatedAt: new Date().toISOString() })
      .where("kind", "=", "agent")
      .where("status", "=", "online")
      .where((eb) => eb.or([eb("lastSeenAt", "is", null), eb("lastSeenAt", "<", olderThanIso)]));
    if (excludeNodeIds && excludeNodeIds.length > 0) {
      query = query.where("id", "not in", excludeNodeIds);
    }
    const res = await query.executeTakeFirst();
    // numUpdatedRows arrives bigint from bun:sqlite and number from some
    // Kysely paths — Number() normalizes both spellings.
    return Number(res?.numUpdatedRows ?? 0);
  }

  /** Bind the node's better-auth apikey id (the anti-forgery link, spec §5.2). */
  async setApiKeyId(id: string, apiKeyId: string): Promise<void> {
    await this.db
      .updateTable("nodes")
      .set({ apiKeyId, updatedAt: new Date().toISOString() })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Profiles pinned to this node — the delete confirm dialog warns with this
   * count (spec §5.4); deleting the node un-pins them, it never deletes them.
   */
  async countPinnedProfiles(id: string): Promise<number> {
    const r = await this.db
      .selectFrom("profiles")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("nodeId", "=", id)
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  /**
   * Delete a node, unpinning profiles in the same transaction (spec §5.4:
   * `profiles.node_id` is NULLed so the profile survives as "any node";
   * `node_shares`/`node_harnesses` ride the FK cascade).
   */
  async deleteById(id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable("profiles").set({ nodeId: null }).where("nodeId", "=", id).execute();
      await tx.deleteFrom("nodes").where("id", "=", id).execute();
    });
  }
}
