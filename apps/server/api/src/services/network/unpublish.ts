import { getNetworkPlugin, type NetworkPluginEntry, type RequestGuardSpec } from "@internal/pane-runtime";
import type { NetworkConfigWrite } from "@/api/network/network-gate.js";
import { removePublishedConfig } from "@/api/network/network-gate.js";
import { IS_TEST } from "@/constants.js";
import { setPluginGuards } from "@/plugins/access-guard.plugin.js";
import { networkContext, readNetworkState, writeNetworkState } from "@/services/network/state.js";
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
 * 5. **Un-trust what the publish trusted.** The origins the recorded publish
 *    added leave `TRUSTED_ORIGINS` with it (spec § 5.4, amended 2026-09-16):
 *    an origin added by a publish now has that publish's lifecycle. The
 *    result carries what happened, because the page must say which of two
 *    things it got — a write awaiting a restart, or a refusal naming the
 *    environment that owns the key.
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
 *
 * **Steps 4 and 5 run for a `publishImplicit` network too** (operator's
 * ruling 2026-09-16, REVERSING this module's first cut, which kept the record
 * and the origins whole). After an unpublish or a disable a NetBird daemon may
 * STILL answer at its own address — membership is what makes it answer, not
 * anything this server runs — but the stripped origins make that address stop
 * ACCEPTING SIGN-INS once the restart lands. That is the stated, chosen cost,
 * and the rule it buys is the one an operator can rely on: a server that no
 * longer describes a network does not keep trusting that network's addresses.
 * Leave — the verb that actually takes the machine off — ends the addresses
 * anyway, so the common path loses nothing. A cleared record then renders
 * `joined`, which is the truth: the host has stopped describing this network
 * as one it publishes on (spec § 5.3, amended twice 2026-09-16).
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
export type UnpublishResult =
  | {
      ok: true;
      /**
       * What became of `TRUSTED_ORIGINS`, or null when the act asked nothing
       * of the file: a plugin that never published recorded no origins to
       * subtract. The `publishImplicit` kind is NOT exempt (§ 5.3, reversed
       * 2026-09-16) — its record and its origins leave like any other's.
       */
      config: NetworkConfigWrite | null;
      /** The origins the recorded publish had added — what `config` answered about; empty when none, or when nothing was asked. */
      origins: string[];
    }
  | { ok: false; message: string; lastLines: string[] };

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
  // Captured BEFORE step 4 clears the record — the publish's addresses live
  // in the host's memory only until then, and step 5 subtracts exactly them
  // from `TRUSTED_ORIGINS`. A plugin that never published recorded nothing,
  // and `origins` stays empty: subtracting nothing is not a reason to touch
  // the file.
  const recorded = await readNetworkState(pluginId);
  const origins = recorded.published ? recorded.addresses.map((address) => address.url) : [];

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
  // Step 5, and the reason the capture had to come first.
  const config = origins.length > 0 ? removePublishedConfig(origins) : null;
  return { ok: true, config, origins };
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
