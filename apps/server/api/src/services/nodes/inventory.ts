import {
  allHarnesses,
  type DetectionReason,
  getHarness,
  type HarnessInventoryEntry,
  scanOne,
} from "@internal/pane-runtime";
import {
  type DetectResultWire,
  type DetectSpecWire,
  type PluginReportWire,
  parseNodeDetectResults,
} from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * Node harness-state resolution (spec 2026-08-31 §6.2) — the single merge of
 * the two per-node stores:
 *
 * - **offered** — the node's own plugin report (`nodes.plugins_json`), for
 *   `local` and for an agent alike: a plugin it has installed is offered, and
 *   there is no enable flag anywhere to consult.
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
  /** local: live binary probe; agent: cached inventory (false until the first inventory lands) */
  installed: boolean;
  /** Version from the inventory (agent nodes only — the local view skips the `--version` probe) */
  version?: string;
  /** Why the binary was not found, when it was not. Absent when installed, and when no probe has run. */
  reason?: DetectionReason;
  /** ISO 8601 stamp of when this entry was probed. Absent when no probe has run. */
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
   * One entry per plugin the node DECLARED, which is not the same set as the
   * registry compiled into this server: a node can offer a plugin this build
   * never heard of, and a plugin this build ships that the node did not
   * install has no row. `local` is no exception to either half.
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
 * `neverReported` is the distinction that matters: a node that has never
 * connected reports nothing at all (the exact-match gate admits no older
 * agent, so this is only ever "not yet dialed"), and rendering that as "this
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
 * Effective harness states for one node — the merge behind `NodeView.harnesses`.
 *
 * ONE path for both kinds, which it was not until phase 2b. Every row is
 * (the node DECLARED this plugin) × (a probe of its binary), and the only
 * things that differ by kind are where each half comes from:
 *
 * | | declared set | probe | `stale` |
 * |---|---|---|---|
 * | `local` | its own report, mirrored into its row at boot and on every change | LIVE, run here | never |
 * | agent | the report it sent | the inventory it sent | past the TTL |
 *
 * `local` used to be the other thing entirely: the registry compiled into
 * this server crossed with a `harness_plugins` table only it had. That is
 * what made "this host offers X" mean two different things depending on the
 * host, and it is why there is no `enabled` here any more. A plugin being
 * installed IS it being offered, everywhere.
 * @param node - the node row to resolve for
 */
export async function effectiveHarnessStates(node: NodeTable): Promise<EffectiveHarnessReport> {
  const declared = readNodePlugins(node);
  const probe = node.kind === "local" ? await probeLocally(declared) : readAgentInventory(node);

  const harnesses = [...declared.entries.values()].map((report) => {
    // Two different facts, deliberately kept apart: the node has the PLUGIN
    // installed (it is in this list at all), and the plugin's BINARY was
    // detected there. A node can have the claude-code plugin and no `claude`
    // on its PATH.
    const entry = probe.entries.get(report.id);
    const state: EffectiveHarnessState = {
      harnessId: report.id,
      installed: entry?.installed === true,
    };
    if (entry?.version) state.version = entry.version;
    if (entry?.reason) state.reason = entry.reason;
    if (entry?.checkedAt) state.checkedAt = entry.checkedAt;
    if (report.broken) state.broken = report.broken;
    if (report.restartRequired) state.restartRequired = true;
    return state;
  });
  return { harnesses, stale: probe.stale };
}

/**
 * The control-plane host's own binary probe, shaped like an agent's inventory.
 *
 * Live rather than cached, so `stale` is never true for it: this process can
 * simply look. `scanOne` is the same function an agent runs, which is what
 * keeps a `reason` or a `checkedAt` meaning the same thing on both sides.
 */
async function probeLocally(declared: NodePluginSet): Promise<AgentInventory> {
  // One clock for the batch: entries probed together should not drift by
  // milliseconds in the reader's eyes.
  const now = new Date();
  // Only what the host DECLARED, and concurrently. Each `scanOne` walks the
  // lookup ladder and spawns `<binary> --version`, so probing the whole
  // compiled registry in sequence made every `GET /api/nodes` pay the sum of
  // five subprocess latencies, including for plugins whose results were then
  // discarded because the host does not offer them.
  const wanted = allHarnesses().filter((h) => declared.entries.has(h.id));
  const probed = await Promise.all(wanted.map(async (h) => [h.id, await scanOne(h, now)] as const));
  // `fresh` is the gate's view and `stale` the reader's; a live probe is both
  // as fresh as it can be and never stale.
  return { entries: new Map<string, HarnessInventoryEntry>(probed), fresh: true, stale: false };
}

/* ------------------------------------------------------------------ */
/* the detect driver (spec 2026-09-10 §4)                               */
/* ------------------------------------------------------------------ */

/**
 * One `detect` spec per plugin THIS BUILD HOLDS, built from the manifest data
 * the pane-runtime adapter attached (`detectSpec`, Task 2) rather than
 * re-reading manifests: the control plane ships the RULE, the node runs the
 * lookup. A plugin with no detect block travels as the empty spec — the node
 * then answers `no-binary` without searching, exactly as `detectFor` reads a
 * manifest with no `detect` block.
 *
 * Not intersected with what the node declared: after the inversion the node
 * has no plugin concept, and extra rows in the cached inventory are inert
 * (`effectiveHarnessStates` iterates the declared set, the gate keys by id).
 * @param harnesses - the set to build from (test seam; default the registry)
 */
export function detectSpecs(harnesses: ReturnType<typeof allHarnesses> = allHarnesses()): DetectSpecWire[] {
  return harnesses.map((h) => ({
    id: h.id,
    binaryName: h.detectSpec?.binaryName ?? "",
    envOverride: h.detectSpec?.envOverride ?? "",
    knownPaths: h.detectSpec?.knownPaths ?? [],
  }));
}

/** Test seams for {@link detectOnNode} (the wire and the stamp clock). */
export interface DetectOnNodeDeps {
  /** Wire seam (default `sendCommand`). */
  send?: typeof sendCommand;
  /** Clock for the `checkedAt` stamp (default `() => new Date()`). */
  now?: () => Date;
}

/**
 * Map one RAW answer row onto a cached inventory entry — the exact shape
 * `applyInventory` stores from the agent's own inventory event, so
 * `INVENTORY_TTL_MS` and every reader keep working unchanged.
 *
 * `rawVersion` becomes `version` here by running the plugin's `parseVersion`,
 * which is the behavior move of the inversion: the node answered text it could
 * not interpret (it holds no plugin code), and this process, which does,
 * interprets it. A parser-less plugin (or one this build never heard of) keeps
 * the raw text — a banner still beats dropping the only version fact.
 */
function detectRowToEntry(row: DetectResultWire, stamp: string): HarnessInventoryEntry {
  const entry: HarnessInventoryEntry = {
    harnessId: row.harnessId,
    installed: row.installed,
    checkedAt: row.checkedAt ?? stamp,
  };
  if (row.binaryPath) entry.binaryPath = row.binaryPath;
  if (row.reason) entry.reason = row.reason;
  if (row.rawVersion !== undefined) {
    const harness = getHarness(row.harnessId);
    const version = harness?.parseVersion ? harness.parseVersion(row.rawVersion) : row.rawVersion;
    if (version) entry.version = version;
  }
  return entry;
}

/**
 * Ask one agent node to run detection NOW, and cache the answer
 * (spec 2026-09-10 §4).
 *
 * The whole flow is a request: the plane ships the rules ({@link detectSpecs}),
 * the node probes and answers RAW, the raw text is parsed HERE with the
 * plugin's `parseVersion`, and the result is merged over the cached snapshot
 * and written through the SAME `applyInventory` path the inventory event uses.
 * Rows the answer does not cover keep their cached values — a third-party
 * plugin only the node's own inventory reports must survive a detect built
 * from this server's registry.
 *
 * **Called from exactly three places: the node page load (best-effort),
 * Re-check, and the launch-driven kick in `RemoteLauncher.#kickDetect` (a
 * failed launch's `binary missing` refresh). Never a timer, never a sweep** —
 * §4: detection runs when someone asks. `local` is a no-op (its view probes
 * live on every read); an unknown id is one, too.
 * @throws whatever `sendCommand` throws (offline/timeout/failed — callers
 * decide), and a plain Error when the agent answered with a malformed payload
 */
export async function detectOnNode(nodeId: string, deps: DetectOnNodeDeps = {}): Promise<void> {
  const nodes = new NodesRepository(db);
  const node = await nodes.findById(nodeId);
  if (!node || node.kind === "local") return;
  const data = await (deps.send ?? sendCommand)(nodeId, { type: "detect", specs: detectSpecs() });
  const rows = parseNodeDetectResults(data);
  if (!rows) throw new Error(`node "${nodeId}" answered the detect command with a malformed payload`);
  const stamp = (deps.now?.() ?? new Date()).toISOString();
  // Read-merge-write on `inventory_json`, and this is NOT the column's only
  // writer: the `/ws/node` handler applies the agent's `inventory` EVENT
  // through the same `applyInventory` (node-ws-handler.ts, `case "inventory"`),
  // so an event landing between the read and the write here can be briefly
  // overwritten by this merge (or vice versa). No interim serialization: the
  // double writer ends when the inventory event stops carrying harnesses —
  // the Task 7/8 demolition — NOT when the protocol number moves.
  const merged = readAgentInventory(node).entries;
  for (const row of rows) merged.set(row.harnessId, detectRowToEntry(row, stamp));
  await nodes.applyInventory(nodeId, JSON.stringify([...merged.values()]));
}

/**
 * {@link detectOnNode}, fire-and-forget with the failure debug-logged.
 *
 * This is the node PAGE LOAD arm. The response renders the cached last-known
 * inventory either way (that is what §4's cache is for), so a node that is
 * offline for the page open — the routine case the moment a machine sleeps —
 * must not surface anything; a debug line is for the operator who then watches
 * a page that never refreshes.
 */
export function detectOnNodeBestEffort(nodeId: string): void {
  void detectOnNode(nodeId).catch((err: unknown) => {
    logger.debug(`detect for node ${nodeId} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
