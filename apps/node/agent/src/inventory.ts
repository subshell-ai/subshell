import { join } from "node:path";
import { adaptPlugin, createInProcessRuntime, type HarnessInventoryEntry, scanOne } from "@internal/pane-runtime";
import type { NodeEvent } from "@internal/subshell-protocol";
import { buildPluginReports } from "./plugin-report.js";
import { listInstalled, pluginsDir } from "./plugins-dir.js";

/** The `inventory` event shape (spec §3.3) — what the backend's `applyInventory` persists. */
export type InventoryEvent = Extract<NodeEvent, { type: "inventory" }>;

/**
 * Window in which a fresh probe is REUSED instead of re-running
 * {@link scanHarnesses}. Three beats can land close together on every
 * connection — the connect push, the backend's §5.3 pull answering `ready`
 * (a command a second later), and the 5-min cadence — and each full probe
 * PATH-walks every harness plus a `<binary> --version` subprocess per
 * installed one. Harness state does not move on that timescale, so the scan
 * is coalesced while the EVENT is not: every caller still stamps its own `ts`
 * and the backend still persists per arrival (fresh `inventoryAt`). A manual
 * Re-check inside the window therefore returns what was just computed —
 * exactly what it would display anyway.
 */
export const INVENTORY_SCAN_MEMO_MS = 10_000;

let memo: { expiresAt: number; promise: Promise<HarnessInventoryEntry[]> } | null = null;

/** Shared scan with in-flight coalescing; a failed scan is never memoized. */
function scanCoalesced(nowMs: number, scan: () => Promise<HarnessInventoryEntry[]>): Promise<HarnessInventoryEntry[]> {
  if (memo && nowMs < memo.expiresAt) return memo.promise;
  const promise = scan();
  promise.catch(() => {
    // Un-memoize on failure (only if WE are still the memo — a newer scan may
    // already have replaced it while this one was rejecting).
    if (memo?.promise === promise) memo = null;
  });
  memo = { expiresAt: nowMs + INVENTORY_SCAN_MEMO_MS, promise };
  return promise;
}

/**
 * Drop the scan memo. Test isolation only — suites that stub the probe
 * per-test must not inherit a previous one.
 * @internal
 */
export function resetInventoryScanCache(): void {
  memo = null;
}

/**
 * Probes the plugins this node has INSTALLED, not the ones this build knows.
 *
 * The two used to be the same list, because everything installable was a
 * built-in. That coincidence ends with a third-party plugin: probing the
 * static registry would leave it with no inventory row at all, so it would
 * report "program not found" forever no matter what is on the machine — and
 * would keep probing a built-in the operator uninstalled.
 *
 * A plugin that will not load is skipped rather than reported absent. Its row
 * already carries `broken`, and a probe verdict beside that reason would only
 * suggest the missing binary is the problem.
 * @param dataDir - the agent's data dir
 * @param now - one stamp for the batch
 */
export async function scanInstalledPlugins(dataDir: string, now: Date = new Date()): Promise<HarnessInventoryEntry[]> {
  const runtime = createInProcessRuntime();
  const entries: HarnessInventoryEntry[] = [];
  for (const installed of await listInstalled(dataDir)) {
    if (installed.broken) continue;
    const loaded = await runtime.load(join(pluginsDir(dataDir), installed.id));
    if ("error" in loaded) continue;
    entries.push(await scanOne(adaptPlugin(loaded.manifest, loaded.plugin), now));
  }
  return entries;
}

/**
 * Build one `inventory` event from a probe of this node's installed plugins
 * ({@link scanCoalesced} — control plane and agent run identical plugin code
 * against their own filesystems, spec §7).
 * @param nowMs - epoch-ms for the `ts` stamp (injectable for deterministic tests)
 * @param scan - probe override (tests); production leaves the default
 * @param dataDir - the agent's data dir; without it there is nothing to probe
 * @returns a wire-valid inventory event (element shape mirrors HarnessInventoryEntry)
 */
export async function buildInventoryEvent(
  nowMs: number = Date.now(),
  scan?: () => Promise<HarnessInventoryEntry[]>,
  dataDir?: string,
): Promise<InventoryEvent> {
  const probe = scan ?? (dataDir ? () => scanInstalledPlugins(dataDir, new Date(nowMs)) : async () => []);
  return {
    type: "inventory",
    harnesses: await scanCoalesced(nowMs, probe),
    // The node's DECLARATION, which is what the control plane mirrors. Absent
    // rather than empty when no data dir was supplied, so a caller that cannot
    // read the plugins directory does not assert that the node has none.
    ...(dataDir ? { plugins: await buildPluginReports(dataDir) } : {}),
    ts: new Date(nowMs).toISOString(),
  };
}
