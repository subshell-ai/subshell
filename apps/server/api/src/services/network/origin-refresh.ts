import {
  getNetworkPlugin,
  hostPlatform,
  type NetworkContext,
  type NetworkPluginEntry,
  type NetworkStatus,
  type PluginPlatform,
} from "@internal/pane-runtime";
import { isSupportedHere, readNetworkStatus } from "@/api/network/network-gate.js";
import { IS_TEST } from "@/constants.js";
import { observeNetworkStatus, originsOf } from "@/services/network/origins.js";
import { networkContext, readNetworkState } from "@/services/network/state.js";
import { processState } from "@/services/network/supervisor.js";
import { enabledNetworkPlugins } from "@/services/nodes/local-plugins.js";
import { originRegistry } from "@/services/trusted-origins.js";
import { getLogger } from "@/utils/logger.js";

/**
 * Keeping the trusted-origin registry right when nobody is looking.
 *
 * Three moments (spec § 10f). **Seed**, before the listener: the records of
 * every enabled network plugin are trusted as they stand, so the first request
 * over a tailnet that survived the restart is not a 403. **Probe**, after the
 * processes are armed: one `status()` per enabled plugin, because a record is
 * what the host last knew and the daemon is what is true now. **Refresh**,
 * every {@link ORIGIN_REFRESH_MS}: the same probe on a timer.
 *
 * THE TIMER IS A DELIBERATE EXCEPTION to "detection is never a timer, never a
 * sweep" (`services/nodes/inventory.ts`, `prepare.ts`'s `reportIfDown`). That
 * rule protects two things: a vendor CLI spawned forever for a page nobody has
 * open, and a background process reporting a fact the page reports better.
 * Neither holds here. The allowlist is consulted on every sign-in by people
 * who will NEVER open the admin Networking page — a phone on the tailnet, a
 * teammate on the LAN — so the page's own polling cannot be what keeps it
 * right; and the cost is bounded to one memoised `status()` per enabled
 * plugin per five minutes, skipping a supervised plugin whose child is armed
 * (its `status()` honestly cannot see the tunnel, and its origins come from
 * the publish record, exactly as `reportIfDown` reasons). Timer-driven
 * refreshes are observations, not acts: they log at info when the set changes
 * and write no audit row.
 */

/** How often every enabled network plugin is re-asked for this host's addresses. */
export const ORIGIN_REFRESH_MS = 5 * 60 * 1000;

/** The seams a test replaces: the plugin set, the registry, this host's OS, the supervisor, the probe, the clock. */
export interface OriginRefreshDeps {
  /** The enabled network plugins. Production: the instance store minus what an admin disabled. */
  listPlugins(): Promise<{ id: string }[]>;
  /** Resolve one loaded plugin. Production: the pane-runtime registry. */
  getPlugin(id: string): NetworkPluginEntry | undefined;
  /** This host's OS in the manifest's vocabulary. */
  platform(): PluginPlatform;
  /** Whether the supervisor holds an entry for this plugin — see `reportIfDown` for why that silences the probe. */
  childArmed(pluginId: string): boolean;
  /** One status read. Production: the gate's memoised `readNetworkStatus`, so a page opening within 3 s reuses it. */
  status(entry: NetworkPluginEntry, ctx: NetworkContext): Promise<NetworkStatus>;
  /** The clock. Production: an unref'd `setInterval`, so a pending tick never holds the process open. */
  schedule(tick: () => void, everyMs: number): { stop(): void };
}

const defaultDeps: OriginRefreshDeps = {
  listPlugins: enabledNetworkPlugins,
  getPlugin: getNetworkPlugin,
  platform: hostPlatform,
  childArmed: (pluginId) => processState(pluginId) !== null,
  status: (entry, ctx) => readNetworkStatus(entry, ctx),
  schedule: (tick, everyMs) => {
    const timer = setInterval(tick, everyMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  },
};

let depsOverride: OriginRefreshDeps | undefined;

/**
 * Test seam. Refuses outside the suite — the `setNetworkPrepareDepsForTests`
 * pattern: a production import able to swap these could redirect which
 * plugin code runs.
 * @internal
 */
export function setOriginRefreshDepsForTests(deps: OriginRefreshDeps | null): void {
  if (!IS_TEST) throw new Error("setOriginRefreshDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

function deps(): OriginRefreshDeps {
  return depsOverride ?? defaultDeps;
}

/** One enabled, loadable, supported network plugin. */
interface Probeable {
  id: string;
  entry: NetworkPluginEntry;
}

/**
 * Every enabled network plugin that can be asked on this host. The platform
 * gate is manifest DATA: a data dir carried from a mac to a Linux box holds
 * records for a plugin that can drive nothing here, and asking it would run a
 * vendor CLI the manifest already said cannot run.
 */
async function probeable(only?: string): Promise<Probeable[]> {
  const out: Probeable[] = [];
  for (const row of await deps().listPlugins()) {
    if (only !== undefined && row.id !== only) continue;
    const entry = deps().getPlugin(row.id);
    if (!entry?.manifest.network) continue;
    if (!isSupportedHere(entry.manifest.network, deps().platform())) continue;
    out.push({ id: row.id, entry });
  }
  return out;
}

/**
 * Trusts every enabled plugin's RECORD, probing nothing. Call BEFORE the
 * listener: a tunnel or tailnet that survived the restart is reachable the
 * millisecond the port opens, and an allowlist seeded after that has already
 * 403'd someone.
 */
export async function seedNetworkOrigins(): Promise<void> {
  for (const { id, entry } of await probeable()) {
    originRegistry().setPluginOrigins(id, originsOf(entry.manifest.network, await readNetworkState(id)));
  }
}

/**
 * One status probe per enabled plugin (or the one named), each observation
 * folded into the record and the registry. A plugin that throws costs its own
 * row and nothing else; a supervised plugin whose child is armed is skipped.
 * @param only - a single plugin id, for the re-enable path
 */
export async function refreshNetworkOrigins(only?: string): Promise<void> {
  for (const { id, entry } of await probeable(only)) {
    if (entry.plugin.supervisedProcess && deps().childArmed(id)) continue;
    try {
      const ctx = await networkContext(id, entry);
      const status = await deps().status(entry, ctx);
      await observeNetworkStatus(id, entry.manifest.network, status);
    } catch (err) {
      getLogger().withError(err).warn(`could not refresh network "${id}"'s addresses`);
    }
  }
}

/** Arms the timer. Returns its stop handle; the interval is unref'd, so nothing need call it on exit. */
export function startOriginRefresh(): { stop(): void } {
  return deps().schedule(() => {
    void refreshNetworkOrigins().catch((err: unknown) =>
      getLogger().withError(err).warn("the trusted-origin refresh failed; the last known list stands"),
    );
  }, ORIGIN_REFRESH_MS);
}
