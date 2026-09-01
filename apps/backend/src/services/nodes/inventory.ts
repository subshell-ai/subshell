import { ALL_HARNESSES, type HarnessInventoryEntry } from "@internal/harnesses";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";

/**
 * Node harness-state resolution (spec 2026-08-31 §6.2) — the single merge of
 * the two per-node stores:
 *
 * - **enabled** — `node_harnesses` rows for agents, `harness_plugins` for the
 *   local node (the lazy rule both times: absent row ⇒ the plugin's
 *   `enabledByDefault`).
 * - **installed/version** — the cached agent inventory (`nodes.inventory_json`
 *   captured by the `/ws/node` handler) or the live process probe for local.
 *
 * Two consumers, deliberately two strictnesses: the VIEW (this module's
 * {@link effectiveHarnessStates}) is informational — a stale snapshot still
 * reports its values, flagged per node via `stale`; the LAUNCH GATE
 * (`harnessUsable` in `api/harness-utils.ts`) is strict — only a fresh
 * (≤ {@link INVENTORY_TTL_MS}) snapshot that says installed counts.
 */

/** Inventory age beyond which the cache is no longer trusted for gating (spec §6.2). */
export const INVENTORY_TTL_MS = 10 * 60 * 1000;

/** One harness row of a node's effective state (the `NodeView.harnesses` entry shape). */
export interface EffectiveHarnessState {
  /** Harness plugin id */
  harnessId: string;
  /** Explicit per-node (agent) / per-instance (local) state when set, else the plugin default */
  enabled: boolean;
  /** local: live binary probe; agent: cached inventory (false until the first inventory lands) */
  installed: boolean;
  /** Version from the inventory (agent nodes only — the local view skips the `--version` probe) */
  version?: string;
}

/** The full per-node harness picture plus the freshness verdict on its source. */
export interface EffectiveHarnessReport {
  /** One entry per registered harness × this node's state */
  harnesses: EffectiveHarnessState[];
  /**
   * Agent nodes: true when the cached inventory is older than the TTL **or has
   * never landed** — the reported `installed` values are the best available,
   * not necessarily true. local: always false (the probe is live per read).
   */
  stale: boolean;
}

/** Parsed `nodes.inventory_json` + the TTL verdict on its timestamp. */
export interface AgentInventory {
  /** `harnessId → entry`; entries without a usable harnessId and junk payloads read as empty */
  entries: Map<string, HarnessInventoryEntry>;
  /** True only when `inventoryAt` parses and sits within the TTL — the gate's strict view */
  fresh: boolean;
  /** `!fresh` — aged OR never-reported (the view's informational flag) */
  stale: boolean;
}

/**
 * Parse one node row's cached inventory and judge its age. Pure (no DB, no
 * probing) so the routes, the gate and the views share one parser and one
 * clock rule.
 * @param node - the node row (reads `inventoryJson`/`inventoryAt`)
 * @param now - clock override for tests (default `Date.now()`)
 */
export function readAgentInventory(node: NodeTable, now: number = Date.now()): AgentInventory {
  const entries = new Map<string, HarnessInventoryEntry>();
  if (node.inventoryJson) {
    try {
      const parsed: unknown = JSON.parse(node.inventoryJson);
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          const entry = e as Partial<HarnessInventoryEntry>;
          if (typeof entry?.harnessId === "string") entries.set(entry.harnessId, entry as HarnessInventoryEntry);
        }
      }
    } catch {
      // junk snapshot → empty map (reads as "nothing reported"), never a throw
    }
  }
  const at = node.inventoryAt ? Date.parse(node.inventoryAt) : Number.NaN;
  const fresh = Number.isFinite(at) && now - at <= INVENTORY_TTL_MS;
  return { entries, fresh, stale: !fresh };
}

// NOTE (ledger 17b): the strict agent launch gate that used to live here as
// `agentInventoryInstalled` is now the ONE predicate `agentHarnessUsable` in
// `api/harness-utils.ts` (gate rule deduped with the batch path there).

/**
 * Effective harness states for every registered plugin on one node — the
 * merge behind `NodeView.harnesses` (spec §6.2). Agent: per-node lazy rows ×
 * the cached inventory; local: `harness_plugins` rows × the live probe.
 *
 * NOTE (dedup): the local branch reads `harness_plugins` through the
 * repository directly — the same lazy rule `api/harness-utils.ts` applies —
 * rather than importing that module's `harnessEnabledStates`, because
 * harness-utils imports this module for the agent gate and a cross-import
 * would cycle (precedent: `services/default-profiles.ts` reads the store the
 * same way).
 * @param node - the node row to resolve for
 */
export async function effectiveHarnessStates(node: NodeTable): Promise<EffectiveHarnessReport> {
  const ids = ALL_HARNESSES.map((h) => h.id);

  if (node.kind === "local") {
    const states = await new HarnessPluginsRepository(db).getEnabledStates(ids);
    const harnesses = await Promise.all(
      ALL_HARNESSES.map(async (h) => ({
        harnessId: h.id,
        enabled: states.get(h.id) ?? h.enabledByDefault,
        installed: await h.isInstalled(),
      })),
    );
    return { harnesses, stale: false };
  }

  const states = await new NodeHarnessesRepository(db).enabledStates(node.id);
  const inv = readAgentInventory(node);
  const harnesses = ALL_HARNESSES.map((h) => {
    const entry = inv.entries.get(h.id);
    const state: EffectiveHarnessState = {
      harnessId: h.id,
      enabled: states.get(h.id) ?? h.enabledByDefault,
      installed: entry?.installed === true,
    };
    if (entry?.version) state.version = entry.version;
    return state;
  });
  return { harnesses, stale: inv.stale };
}
