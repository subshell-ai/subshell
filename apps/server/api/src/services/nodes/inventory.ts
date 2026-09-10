import { allHarnesses, type DetectionReason, type HarnessInventoryEntry, scanOne } from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";

/**
 * Node harness-state resolution (spec 2026-08-31 §6.2) — the single merge of
 * the two per-node stores:
 *
 * - **offered** — for an agent, the node's own plugin report
 *   (`nodes.plugins_json`): a plugin it has installed is offered, and there is
 *   no enable flag to consult. For `local` it is still `harness_plugins`, with
 *   the lazy rule that an absent row means the plugin's `enabledByDefault`.
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
  /** Why the binary was not found, when it was not. Absent when installed, and absent from older agents. */
  reason?: DetectionReason;
  /** ISO 8601 stamp of when this entry was probed. Absent from older agents. */
  checkedAt?: string;
  /**
   * Why the node cannot use this plugin, when it cannot.
   *
   * Carried all the way to the view because the whole reason a broken plugin
   * keeps a ROW is so a page can say why. Dropping it here made the row render
   * as an ordinary healthy plugin whose launches then failed silently.
   */
  broken?: string;
  /**
   * The node holds a newer copy of the plugin than the code it is running.
   *
   * Everything this row reports that came from the PLUGIN (its capabilities,
   * its settings schema, and `broken`) is then the previous copy's answer.
   * `version` on this row is a different fact and is unaffected: it is the
   * driven program's version, from the binary probe. The remedy is a restart
   * of that agent, so the state has to reach a screen an operator looks at.
   */
  restartRequired?: boolean;
}

/** The full per-node harness picture plus the freshness verdict on its source. */
export interface EffectiveHarnessReport {
  /**
   * The rows for this node.
   *
   * For an AGENT that is one entry per plugin the node DECLARED, which is not
   * the same set as the registry compiled into this server: a node can offer
   * a plugin this build never heard of, and a plugin this build ships that
   * the node did not install has no row. For `local` it is still one per
   * registered harness.
   */
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

/** Parsed `nodes.plugins_json`: what the node said it has installed. */
export interface NodePluginSet {
  /** `pluginId → report`, in the order the node listed them */
  entries: Map<string, PluginReportWire>;
  /** True when the node has never reported, which is NOT "offers nothing" */
  neverReported: boolean;
}

/**
 * Parse one node row's reported plugin set.
 *
 * Pure, like {@link readAgentInventory}, so the view and the launch gate share
 * one parser and one idea of what a junk payload means.
 *
 * `neverReported` is the distinction that matters: a node running an agent
 * older than protocol v6 reports nothing at all, and rendering that as "this
 * node offers no plugins" would be a confident lie about a machine that simply
 * has not been asked.
 */
export function readNodePlugins(node: NodeTable): NodePluginSet {
  const entries = new Map<string, PluginReportWire>();
  if (!node.pluginsJson) return { entries, neverReported: true };
  try {
    const parsed: unknown = JSON.parse(node.pluginsJson);
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        const entry = e as Partial<PluginReportWire>;
        if (typeof entry?.id === "string") entries.set(entry.id, entry as PluginReportWire);
      }
    }
  } catch {
    // Junk reads as an empty report rather than a throw, same as the inventory
    // parser. A node that reported garbage HAS reported.
  }
  return { entries, neverReported: false };
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
  const ids = allHarnesses().map((h) => h.id);

  if (node.kind === "local") {
    const states = await new HarnessPluginsRepository(db).getEnabledStates(ids);
    // One clock for the batch, and `scanOne` rather than a bare isInstalled():
    // the local branch reports the same reason and stamp an agent does, from
    // the same function, so the two halves of this merge cannot disagree about
    // what an entry means.
    const now = new Date();
    const harnesses = await Promise.all(
      allHarnesses().map(async (h) => {
        const entry = await scanOne(h, now);
        const state: EffectiveHarnessState = {
          harnessId: h.id,
          enabled: states.get(h.id) ?? h.enabledByDefault,
          installed: entry.installed,
        };
        if (entry.version) state.version = entry.version;
        if (entry.reason) state.reason = entry.reason;
        if (entry.checkedAt) state.checkedAt = entry.checkedAt;
        return state;
      }),
    );
    return { harnesses, stale: false };
  }

  // An agent's rows come from what the NODE declared, not from the registry
  // compiled into this server crossed with a table this server owned. That
  // table is gone: a plugin being installed on the node IS it being offered
  // there, so `enabled` is true for every row that exists.
  const inv = readAgentInventory(node);
  const declared = readNodePlugins(node);
  const harnesses = [...declared.entries.values()].map((report) => {
    // Two different facts, deliberately kept apart: the node has the PLUGIN
    // installed (it is in this list at all), and the plugin's BINARY was
    // detected there (the harness inventory). A node can have the claude-code
    // plugin and no `claude` on its PATH.
    const entry = inv.entries.get(report.id);
    const state: EffectiveHarnessState = {
      harnessId: report.id,
      enabled: true,
      installed: entry?.installed === true,
    };
    if (entry?.version) state.version = entry.version;
    if (entry?.reason) state.reason = entry.reason;
    if (entry?.checkedAt) state.checkedAt = entry.checkedAt;
    if (report.broken) state.broken = report.broken;
    if (report.restartRequired) state.restartRequired = true;
    return state;
  });
  return { harnesses, stale: inv.stale };
}
