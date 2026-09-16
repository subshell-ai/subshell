import {
  allHarnesses,
  type DetectionReason,
  getHarness,
  type HarnessInventoryEntry,
  type HarnessPlugin,
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
import { enabledHarnessPlugins } from "@/services/nodes/local-plugins.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * Per-node harness-state resolution, post-inversion (spec 2026-09-10).
 *
 * There is ONE plugin store — the instance's own directory — and ONE rule: a
 * harness exists for a node when the INSTANCE has the plugin (installed and
 * enabled, `local-plugins.ts`), and whether it RUNS there is that node's
 * detection answer. The two halves come from different places per node, and
 * that is the only remaining difference between `local` and an agent:
 *
 * | | catalog (what rows exist) | detection (is the binary there) |
 * |---|---|---|
 * | `local` | the instance store | LIVE probe, run here |
 * | agent | the instance store | the cached `detect` answer |
 *
 * The `node.kind` branch inside the usability GATE is gone with the per-node
 * plugin set it branched on (`nodes.plugins_json`/`plugins_at`, dropped by
 * migration 0026 — this module stopped reading them first).
 *
 * Two consumers, deliberately two strictnesses: the VIEW
 * ({@link effectiveHarnessStates}) is informational — a stale snapshot still
 * reports its values, flagged per node via `stale`; the LAUNCH GATE
 * (`harnessUsable` / `usableHarnessIds` in `api/harness-utils.ts`) is strict —
 * only a fresh (≤ {@link INVENTORY_TTL_MS}) answer that says installed counts.
 */

/** Inventory age beyond which the cache is no longer trusted for gating (spec §6.2). */
export const INVENTORY_TTL_MS = 10 * 60 * 1000;

/** One harness row of a node's effective state (the `NodeView.harnesses` entry shape). */
export interface EffectiveHarnessState {
  /** Harness plugin id */
  harnessId: string;
  /**
   * Plugin display name from the instance store's manifest. The id is an
   * identifier; a row a person reads should say "Claude Code", not
   * "claude-code" (spec 2026-09-10 vocabulary rule: labels are not ids).
   */
  name: string;
  /** local: live binary probe; agent: cached inventory (false until the first detection lands) */
  installed: boolean;
  /** Version from the detection (agent nodes only — the local view skips nothing: the probe answers it) */
  version?: string;
  /** Why the binary was not found, when it was not. Absent when installed, and when no probe has run. */
  reason?: DetectionReason;
  /** ISO 8601 stamp of when this entry was probed. Absent when no probe has run. */
  checkedAt?: string;
  /**
   * Why the plugin cannot be used at all, when it cannot — an INSTANCE fact
   * now: the plugin failed to load in the control-plane process, so it is
   * unusable on every node alike.
   *
   * Carried all the way to the view because the whole reason a broken plugin
   * keeps a ROW is so a page can say why. Dropping it here made the row render
   * as an ordinary healthy plugin whose launches then failed silently.
   */
  broken?: string;
  /**
   * The instance holds a newer copy of the plugin than the code THIS process
   * is running.
   *
   * Everything this row reports that came from the PLUGIN (its capabilities,
   * its settings schema, and `broken`) is then the previous copy's answer.
   * `version` on this row is a different fact and is unaffected: it is the
   * driven program's version, from the binary probe. The remedy is a restart
   * of the SERVER, so the state has to reach a screen an operator looks at.
   */
  restartRequired?: boolean;
}

/** The full per-node harness picture plus the freshness verdict on its source. */
export interface EffectiveHarnessReport {
  /**
   * The rows for this node: one per plugin the INSTANCE has installed and
   * enabled. Not per plugin this node's cache happens to mention (a ghost
   * entry is inert), and not including a disabled plugin — disabling removes
   * the row everywhere, which is the whole point of the flag (§6.1).
   */
  harnesses: EffectiveHarnessState[];
  /**
   * Agent nodes: true when the cached detection is older than the TTL **or
   * has never landed** — the reported `installed` values are the best
   * available, not necessarily true. local: always false (the probe is live
   * per read).
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

/**
 * The control-plane host's own binary probe, shaped like an agent's inventory.
 *
 * Live rather than cached, so `stale` is never true for it: this process can
 * simply look. `scanOne` is the same function an agent used to run against
 * itself, which keeps a `reason` or a `checkedAt` meaning the same thing on
 * both sides.
 *
 * Since Task 9b the registry overlay resolves installed third-party plugins
 * too, so every healthy install has a `HarnessPlugin` to probe through. What
 * still gets NO entry: a plugin the overlay does not hold — broken at the
 * last refresh, or placed on disk without one — because `getHarness` is the
 * only place binary lookup rules live. Absent reads as "not found" for
 * gating and as a quiet unknown for the view, which is the honest answer,
 * not a shrug: the launch path has the same boundary (`subshell-manager`
 * builds argv from registry code too).
 * @param installed - the instance catalog to probe (already enabled-filtered;
 * broken entries are skipped — there is no plugin object to ask)
 */
export async function probeLocally(installed: readonly PluginReportWire[]): Promise<AgentInventory> {
  // One clock for the batch: entries probed together should not drift by
  // milliseconds in the reader's eyes.
  const now = new Date();
  const wanted = installed.filter((r) => !r.broken);
  // Each `scanOne` walks the lookup ladder and spawns `<binary> --version`, so
  // probing the whole compiled registry in sequence made every `GET
  // /api/nodes` pay the sum of five subprocess latencies. Only what the
  // instance actually has, and concurrently.
  const probed = await Promise.all(
    wanted.flatMap((r) => {
      const h = getHarness(r.id);
      return h ? [[r.id, scanOne(h, now)] as const] : [];
    }),
  );
  const entries = new Map<string, HarnessInventoryEntry>();
  for (const [id, p] of probed) entries.set(id, await p);
  // `fresh` is the gate's view and `stale` the reader's; a live probe is both
  // as fresh as it can be and never stale.
  return { entries, fresh: true, stale: false };
}

/**
 * The gate's shallow probe: resolve each plugin's binary, skip the
 * `<binary> --version` spawn.
 *
 * The launch gate asks exactly one question per plugin — is the program
 * there — and {@link probeLocally}'s `versionAt` call pays a full subprocess
 * (seconds for a Node CLI) for a version the gate then throws away. This is
 * the same `detect()` resolution `isInstalled()` ran behind the old gate,
 * kept from regressing the auto-restart sweeps; the VIEW still wants the
 * version, so it keeps `probeLocally`.
 * @param installed - the (enabled, unfiltered-by-broken) instance catalog
 */
export async function probeInstalledOnly(installed: readonly PluginReportWire[]): Promise<AgentInventory> {
  const now = new Date();
  const entries = new Map<string, HarnessInventoryEntry>();
  await Promise.all(
    installed
      .filter((r) => !r.broken)
      .flatMap((r) => {
        const h = getHarness(r.id);
        if (!h) return []; // unresolved (broken or since-refresh) ⇒ no lookup rules ⇒ no entry (see probeLocally)
        return [
          (async () => {
            const checkedAt = now.toISOString();
            try {
              const found = await h.detect();
              if (found.path === null) {
                entries.set(r.id, { harnessId: r.id, installed: false, reason: found.reason, checkedAt });
              } else {
                entries.set(r.id, { harnessId: r.id, installed: true, binaryPath: found.path, checkedAt });
              }
            } catch {
              // Same containment as `scanOne`: a throwing probe reads as
              // unknown-but-absent, and reports no reason because there
              // is not one.
              entries.set(r.id, { harnessId: r.id, installed: false, checkedAt });
            }
          })(),
        ];
      }),
  );
  return { entries, fresh: true, stale: false };
}

/**
 * Effective harness states for one node — the merge behind `NodeView.harnesses`.
 *
 * ONE rule for every node, which is the whole shape of the inversion: rows
 * come from the instance catalog, the binary answer comes from the node.
 * @param node - the node row to resolve for
 * @param installed - the instance catalog, pre-read (list rendering passes
 * the same array down every row so the disk is read once per request; a
 * single-node caller may omit it and this reads the store itself)
 */
export async function effectiveHarnessStates(
  node: NodeTable,
  installed?: readonly PluginReportWire[],
): Promise<EffectiveHarnessReport> {
  const catalog = installed ? [...installed] : await enabledHarnessPlugins();
  const probe = node.kind === "local" ? await probeLocally(catalog) : readAgentInventory(node);

  const harnesses = catalog.map((report) => {
    // Two different facts, deliberately kept apart: the INSTANCE has the
    // PLUGIN (it is in this list at all), and the node's detection found its
    // BINARY there. A machine can face the claude-code plugin and have no
    // `claude` on its PATH.
    const entry = probe.entries.get(report.id);
    const state: EffectiveHarnessState = {
      harnessId: report.id,
      name: report.name,
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

/* ------------------------------------------------------------------ */
/* the detect driver (spec 2026-09-10 §4)                               */
/* ------------------------------------------------------------------ */

/**
 * One `detect` spec per RESOLVABLE plugin — the merged registry, so an
 * installed third-party plugin ships its spec exactly like a built-in does
 * (Task 9b is what makes `allHarnesses()` include it) — built from the
 * manifest data the pane-runtime adapter attached (`detectSpec`, Task 2/R5)
 * rather than re-reading manifests: the control plane ships the RULE, the
 * node runs the lookup. A plugin with no detect block travels as the empty
 * spec — the node then answers `no-binary` without searching, exactly as
 * `detectFor` reads a manifest with no `detect` block.
 *
 * The registry is the right source and the whole boundary: a plugin the
 * registry cannot resolve has no lookup rules to ship, and its node rows
 * stay "not detected" rather than guessing.
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

/**
 * The env names to ask one node about: the union of `hostEnv` across the
 * given harnesses (spec 2026-09-10 §5 as amended by the final review).
 *
 * The declarations are manifest DATA the control plane holds (and the node
 * no longer does, §6), so the PLANE names the variables and the node only
 * answers values. Callers pass the ENABLED set — a disabled plugin asks for
 * nothing, its resume path is not a question anyone can ask.
 */
export function detectEnvNames(harnesses: readonly HarnessPlugin[]): string[] {
  const names = new Set<string>();
  for (const h of harnesses) for (const name of h.hostEnv ?? []) names.add(name);
  return [...names];
}

/** Test seams for {@link detectOnNode} (the wire and the stamp clock). */
export interface DetectOnNodeDeps {
  /** Wire seam (default `sendCommand`). */
  send?: typeof sendCommand;
  /** Clock for the `checkedAt` stamp (default `() => new Date()`). */
  now?: () => Date;
  /**
   * Seam for the env-names catalog: which harnesses' declarations the plane
   * asks about (default: the instance's enabled set resolved through the
   * registry). @internal test seam.
   */
  envHarnesses?: () => Promise<HarnessPlugin[]>;
}

/**
 * The enabled harnesses whose `hostEnv` declarations the plane asks nodes
 * about: the instance catalog (`plugin_state`-filtered, §6.1) resolved
 * through the registry overlay. A catalog entry the registry cannot resolve
 * (broken at the last refresh) contributes nothing — it has no manifest data
 * to ask about, exactly as it has no lookup rules to ship.
 * @internal exported for the wiring pin in `inventory-detect.test.ts`;
 * production calls it only through {@link detectOnNode}.
 */
export async function enabledEnvHarnesses(): Promise<HarnessPlugin[]> {
  const catalog = await enabledHarnessPlugins();
  return catalog.flatMap((r) => {
    const h = getHarness(r.id);
    return h ? [h] : [];
  });
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
 * (spec 2026-09-10 §4, env-on-detect per §5 as amended by the final review).
 *
 * The whole flow is a request: the plane ships the rules ({@link detectSpecs})
 * AND the env names it wants values for ({@link detectEnvNames} over the
 * enabled manifests — the node holds no manifests to name them itself), the
 * node probes and answers RAW, the raw text is parsed HERE with the plugin's
 * `parseVersion`, and the result is merged over the cached snapshot and
 * written through the SAME `applyInventory` path the inventory event uses.
 * Rows the answer does not cover keep their cached values — a ghost id only a
 * previous scan reported must survive a detect built from this server's
 * registry until something drops it. The env answers go to the live
 * connection's facts, where `RemoteLauncher.canResume` composes resume paths
 * from them.
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
  const envHarnesses = await (deps.envHarnesses ?? enabledEnvHarnesses)();
  const data = await (deps.send ?? sendCommand)(nodeId, {
    type: "detect",
    specs: detectSpecs(),
    envNames: detectEnvNames(envHarnesses),
  });
  const answer = parseNodeDetectResults(data);
  if (!answer) throw new Error(`node "${nodeId}" answered the detect command with a malformed payload`);
  const { rows } = answer;
  const stamp = (deps.now?.() ?? new Date()).toISOString();
  // Read-merge-write on `inventory_json`. This is the column's only writer
  // of real rows: the agent's `inventory` EVENT still arrives through the
  // `/ws/node` handler, but since the Task 7/8 demolition a protocol-3 agent
  // sends `harnesses: []` on every one of them, and the handler treats the
  // empty claim as "nothing to apply" — it can never overwrite these rows.
  const merged = readAgentInventory(node).entries;
  for (const row of rows) merged.set(row.harnessId, detectRowToEntry(row, stamp));
  await nodes.applyInventory(nodeId, JSON.stringify([...merged.values()]));
  // The resume-path env (spec §5 as amended): this round trip is the only
  // place these values arrive now, so it is also the seam that stashes them
  // where `canResume` reads them. The connection is live by construction (the
  // command just rode it); its `agent` facts are absent only in the sliver
  // before `ready` lands, and there is then no facts object to update.
  const conn = getLive(nodeId);
  if (conn?.agent) conn.agent.env = answer.env;
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
