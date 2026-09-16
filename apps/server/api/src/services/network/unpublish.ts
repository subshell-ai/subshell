import { getNetworkPlugin, type NetworkPluginEntry, type RequestGuardSpec } from "@internal/pane-runtime";
import { IS_TEST } from "@/constants.js";
import { setPluginGuards } from "@/plugins/access-guard.plugin.js";
import { networkContext, writeNetworkState } from "@/services/network/state.js";
import { disarmProcess, processState } from "@/services/network/supervisor.js";
import { getLogger } from "@/utils/logger.js";

/**
 * Taking this server off one network, in the one order that is safe.
 *
 * The ORDER is the whole module, and it is the inverse of publishing rather
 * than an arbitrary teardown:
 *
 * 1. **Stop the process**, and wait for it to be reaped. Everything after this
 *    may assume no traffic can still arrive over this network.
 * 2. **Tell the plugin**, so the vendor's half is undone — a tunnel record
 *    deleted, an advertised route withdrawn.
 * 3. **Drop the guard.**
 * 4. **Record it.**
 *
 * Guard-off is LAST because a guard is the identity check in front of the
 * traffic this publish invited. Dropping it first would leave a window,
 * however short, in which a live tunnel reaches an unguarded server — the one
 * state this feature must never produce. Dropping it last costs nothing: a
 * guard with no traffic to inspect is inert.
 *
 * That is also why a failure at step 1 REPORTS rather than continues. A
 * process that would not die is a publish that is still live, and unwinding
 * the rest around it would be tidying up while the door stands open.
 */

/** The seams a test replaces, so the ORDER above can be asserted with a recording fake. */
export interface UnpublishDeps {
  /** Resolve one loaded plugin. Production: the pane-runtime registry. */
  getPlugin(id: string): NetworkPluginEntry | undefined;
  /** Stop and forget the plugin's child, resolving only once it is reaped. */
  disarm(pluginId: string): Promise<void>;
  /** What the child last printed, for a refusal's message. */
  lastLines(pluginId: string): string[];
  /** Replace the guards owned by one plugin; empty removes them. */
  setPluginGuards(pluginId: string, specs: RequestGuardSpec[]): void;
}

const defaultDeps: UnpublishDeps = {
  getPlugin: getNetworkPlugin,
  disarm: disarmProcess,
  lastLines: (pluginId) => processState(pluginId)?.lastLines ?? [],
  setPluginGuards,
};

let depsOverride: UnpublishDeps | undefined;

/**
 * Test seam: swap the registry, the supervisor and the guard set. Refuses
 * outside the suite, like every other seam here.
 * @internal
 */
export function setUnpublishDepsForTests(deps: UnpublishDeps | null): void {
  if (!IS_TEST) throw new Error("setUnpublishDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

function deps(): UnpublishDeps {
  return depsOverride ?? defaultDeps;
}

/** What unpublishing produced. A refusal carries what the child last said, for the page. */
export type UnpublishResult = { ok: true } | { ok: false; message: string; lastLines: string[] };

/**
 * Unpublishes this server from one network.
 *
 * Steps 2 and 3 are best-effort in a way step 1 is not: a plugin whose
 * `unpublish` throws has left something on the VENDOR's side, which an
 * operator can see and clean up, while everything local is already safe. So a
 * plugin failure does not stop the guard being dropped or the row being
 * written — the alternative is an instance that believes it is published on a
 * network it has no process for.
 * @param pluginId - the network plugin to unpublish. An unknown or unloadable
 * one still has its state cleared: a plugin that cannot be loaded cannot be
 * holding anything either.
 */
export async function unpublishNetwork(pluginId: string): Promise<UnpublishResult> {
  try {
    await deps().disarm(pluginId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `could not stop the supervised process for "${pluginId}", so its guard is still in place: ${message}`,
      lastLines: deps().lastLines(pluginId),
    };
  }

  const entry = deps().getPlugin(pluginId);
  if (entry?.plugin.unpublish) {
    try {
      await entry.plugin.unpublish(await networkContext(pluginId, entry));
    } catch (err) {
      getLogger()
        .withError(err)
        .warn(
          `network plugin "${pluginId}" failed to unpublish its own side; this server has stopped serving it regardless`,
        );
    }
  }

  await dropGuardsOf(pluginId);
  await writeNetworkState(pluginId, { published: false, addresses: [], port: null });
  return { ok: true };
}

/**
 * Removes one plugin's guards from the active set, identified by OWNER.
 *
 * It used to identify them by VALUE — ask the plugin what it declares now, and
 * remove exactly those specs — reasoning that a {@link RequestGuardSpec}
 * carries no plugin id and a field a plugin filled in would be a field one
 * plugin could use to name another's. The second half of that is still true
 * and the spec still carries no id. What was wrong is that recomputing the
 * value is not a way to FIND the installed one: a settings write while
 * published changes the hostname or the audience the plugin describes, so the
 * guard standing in front of live traffic no longer matched what the plugin
 * now said, and nothing short of a restart could take it down.
 *
 * Ownership is the host's own record — the id it looked the plugin up by —
 * so nothing a plugin supplies is trusted, and removal cannot miss.
 */
async function dropGuardsOf(pluginId: string): Promise<void> {
  deps().setPluginGuards(pluginId, []);
}
