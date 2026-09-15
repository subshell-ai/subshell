import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { MaintenanceSource, NewNode, NodeStatus, NodeTable } from "@/db/types/nodes.db-types.js";
import type { SubshellTable } from "@/db/types/subshells.db-types.js";

/** Fields a `ready` frame carries about the machine behind a node (spec §5.3). */
export type NodeReadyReport = {
  /** subshell version reported by the agent */
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
        // A new node launches. `0` is the column default (migration 0031) and
        // the reading every pre-column row gets; mirroring it here keeps the
        // read-back complete rather than typed-but-unset.
        maintenance: input.maintenance ?? 0,
        maintenanceAt: input.maintenanceAt ?? null,
        maintenanceSource: input.maintenanceSource ?? null,
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

  /**
   * Write the maintenance flag and the stamp that decides a disagreement
   * (spec 2026-09-14 §5.2).
   *
   * All three fields move together, always: a flag without its stamp cannot
   * be reconciled against the node's copy (every comparison would read as
   * "the plane never wrote one"), and a stamp without its source leaves the
   * page unable to say which end declared the window. The caller supplies
   * `changedAt` rather than this method stamping `now` — an ADOPTED value is
   * a fact about the node's write, and re-stamping it here would make the
   * relay outrank the decision it was carrying.
   */
  async setMaintenance(
    id: string,
    state: {
      /** True = this node accepts no new subshells. */
      on: boolean;
      /** ISO 8601 of the write that produced `on` — never re-stamped on relay. */
      changedAt: string;
      /** Which end wrote it. */
      source: MaintenanceSource;
    },
  ): Promise<NodeTable | undefined> {
    return await this.db
      .updateTable("nodes")
      .set({
        maintenance: state.on ? 1 : 0,
        maintenanceAt: state.changedAt,
        maintenanceSource: state.source,
        updatedAt: new Date().toISOString(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The unfinished subshells on one node, as FULL rows.
   *
   * {@link countRunningSubshells} answers the delete guard's question ("is
   * anything still here"); entering maintenance has to ACT on each one, and
   * every step of that act is row-scoped: the terminate path is owner-keyed
   * (a node-wide stop must pass each row's own `userId`, never the actor's,
   * or the guard silently skips everybody else's work) and the pane kill
   * needs the row's `tmuxSocket`. Same `running` reading as the count: parked
   * auto-restart rows (`running, alive: 0`) are work that has not ended, and
   * leaving them would let the sweep respawn a pane on a node in maintenance.
   */
  async listRunningForNode(nodeId: string): Promise<SubshellTable[]> {
    return await this.db
      .selectFrom("subshells")
      .selectAll()
      .where("nodeId", "=", nodeId)
      .where("status", "=", "running")
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

  /**
   * Subshells still unfinished on this node — `status = 'running'`. The
   * subshell status vocabulary is exactly `running | terminated` (there is no
   * "starting"; a spawned-but-unconfirmed harness is `running` with `alive`
   * 0→1 settling, and a parked auto-restart row is `running, alive: 0`), so
   * `running` IS the live set and parked rows count — from the node's side
   * they are work that has not ended. Used by the delete guard (spec §5.4).
   */
  async countRunningSubshells(nodeId: string): Promise<number> {
    const r = await this.db
      .selectFrom("subshells")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("nodeId", "=", nodeId)
      .where("status", "=", "running")
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  /** Bind the node's better-auth apikey id (the anti-forgery link, spec §5.2); null clears it. */
  async setApiKeyId(id: string, apiKeyId: string | null): Promise<void> {
    await this.db
      .updateTable("nodes")
      .set({ apiKeyId, updatedAt: new Date().toISOString() })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Delete a node (spec §5.4). `node_shares` ride the FK cascade; the plugin
   * set was never row-scoped state to clean — since the inversion the instance
   * owns it. The preset pin died with spec 2026-09-13 §2.3, so there is no
   * un-pin step left: presets never reference a node any more.
   */
  async deleteById(id: string): Promise<void> {
    await this.db.deleteFrom("nodes").where("id", "=", id).execute();
  }
}
