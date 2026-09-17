import { getNetworkPlugin, type NetworkManifest, type NetworkStatus } from "@internal/pane-runtime";
import { IS_TEST } from "@/constants.js";
import { isPluginEnabledSync } from "@/db/repositories/plugin-state.repository.js";
import { type NetworkPluginState, readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { originRegistry } from "@/services/trusted-origins.js";

/**
 * How a network plugin's RECORD becomes trusted origins (spec § 10f).
 *
 * The registry (`services/trusted-origins.ts`) holds one set per plugin and
 * knows nothing about networks; this module is the single derivation of those
 * sets — every write goes through `originsOf` — and it derives them from
 * `network.json` rather than from a status in
 * hand — so a boot that has probed nothing yet, a status read, a publish and
 * an unpublish all arrive at the same answer by the same rule.
 *
 * Until 2026-09-16 a publish WROTE its addresses into config.env's
 * `TRUSTED_ORIGINS` and the union/subtraction pair in `network-gate.ts` kept
 * that file honest. That made the allowlist a boot-time fact, every publish
 * `restartRequired`, and a joined tailnet address — which already served the
 * app — 403 on sign-in until someone restarted. The file now carries the
 * operator's own extras only; what a plugin contributes is read from here.
 */

/** The status states in which a plugin's reported addresses are this host's addresses. */
export const ORIGIN_BEARING_STATES: ReadonlySet<NetworkStatus["state"]> = new Set(["joined", "published"]);

/** Production loadability: what this build's compiled-in set plus the installed overlay resolve. */
const resolvableInRegistry = (pluginId: string): boolean => getNetworkPlugin(pluginId) !== undefined;

/**
 * The loadability oracle {@link observeNetworkStatus} consults, behind a seam.
 *
 * The enabled guard cannot cover UNINSTALL: a completed uninstall clears the
 * plugin's `plugin_state` row, and an absent row means ENABLED — the default
 * that keeps installs cheap would re-open trust for a plugin whose bytes are
 * gone. Loadability is uninstall's true state, and `getNetworkPlugin` is its
 * synchronous oracle: built-ins answer from the compiled set, installed
 * plugins from the overlay that `uninstallLocalPlugin` refreshes. So a
 * probe already in flight when the uninstall landed finds the plugin gone at
 * both guard points and records nothing.
 *
 * The seam exists for the suites that drive fakes through the route deps or
 * the refresh deps — fakes the REAL registry never holds — and it is
 * test-only by construction, the `setOriginRefreshDepsForTests` pattern.
 * @internal
 */
let resolvesPlugin: (pluginId: string) => boolean = resolvableInRegistry;

/**
 * Swaps the loadability oracle for a test; `null` restores the real registry.
 * Refuses outside the suite.
 * @internal
 */
export function setNetworkOriginsResolveForTests(fn: ((pluginId: string) => boolean) | null): void {
  if (!IS_TEST) throw new Error("setNetworkOriginsResolveForTests is a test-only seam");
  resolvesPlugin = fn ?? resolvableInRegistry;
}

/**
 * The trust scope, as one rule.
 *
 * - `private` (Tailscale, Headscale, NetBird): every recorded address, joined
 *   or published. `http://<tailnet-ip>:<port>` answers with no `serve` at all
 *   — membership is what makes it reachable, so membership is what trusts it.
 * - `public-with-gate` (Cloudflare Tunnel): only from a record that says
 *   `published`. The Access guard is installed before a publish completes
 *   (`publish-network.route.ts`) and never before, so a joined-but-unpublished
 *   hostname is an address nothing is checking yet.
 *
 * A plugin whose manifest carries no `network` block describes no network and
 * contributes nothing, whatever its record says.
 */
export function originsOf(
  manifest: Pick<NetworkManifest, "exposure"> | undefined,
  record: Pick<NetworkPluginState, "published" | "addresses">,
): string[] {
  if (manifest === undefined) return [];
  if (manifest.exposure === "public-with-gate" && !record.published) return [];
  return record.addresses.map((address) => address.url);
}

/** Re-derives one plugin's contribution from its record on disk. */
export async function syncNetworkOrigins(
  pluginId: string,
  manifest: Pick<NetworkManifest, "exposure"> | undefined,
): Promise<void> {
  originRegistry().setPluginOrigins(pluginId, originsOf(manifest, await readNetworkState(pluginId)));
}

/** Two address lists as one string each, for the "did anything change" test. */
function fingerprint(addresses: NetworkPluginState["addresses"]): string {
  return JSON.stringify(addresses.map((a) => [a.url, a.scheme, a.label, a.secureContext]));
}

/**
 * Folds one status read into the record and the registry.
 *
 * Only a `joined`/`published` read carries this host's addresses; anything
 * below keeps the last known ones — a daemon that is down has not left the
 * network, and an address that answers nothing is a harmless entry in an
 * allowlist (nobody can be sent to it). The record is rewritten only when the
 * addresses differ, because this runs on every uncached probe.
 *
 * **THE ENABLED GUARD — a forget must survive the probe already in flight.**
 * The refresher and the page's list read capture their plugin list, then
 * await a multi-second `status()`; a disable can complete in between, and its
 * `forgetNetworkOrigins` must not be undone by this function's return. Both
 * checks below are the synchronous read of `plugin_state`
 * (`isPluginEnabledSync`), never a DB await:
 *
 * - At entry: a plugin already disabled — or already uninstalled, which the
 *   enabled check alone cannot see (spec 2026-09-10 § 6.1: an uninstalled
 *   plugin's row is CLEARED, and an absent row means enabled; loadability is
 *   uninstall's true state, so `resolvesPlugin` is checked beside the flag) —
 *   is not observed at all: no record write, no trust. (Every production
 *   path that probes has hydrated the enabled view via `stateByPluginId`
 *   before this call, but the guard below is the one that carries the
 *   safety, so cold-cache fail-open costs nothing.)
 * - Immediately before the registry write, with NO await between: the
 *   disable route flips `enabled=false` synchronously BEFORE its forget (its
 *   lock keeps that order), so a check that answers `true` proves the forget
 *   has not run yet — and since the write lands in this same synchronous
 *   turn, it lands first and the forget wins. That is airtight for the
 *   registry, which is the thing that accepts sign-ins. The uninstall twin
 *   has the same shape against the overlay: once `uninstallLocalPlugin`'s
 *   refresh has run, the answer is false forever, so no later probe writes.
 *
 * The RECORD write therefore stays BEFORE the final guard, and that is the
 * considered choice, not an oversight: a guard with an await after it guards
 * nothing (`writeNetworkState` is real fs I/O — a disable completing through
 * it is exactly the race), and reordering the write after the check would
 * reintroduce the poisoning it exists to prevent. The cost is that a disable
 * interleaving precisely through the record write can leave addresses in the
 * record the disable's clear removed; the record says "last addresses known",
 * the daemon reported these seconds ago, and a re-enable probes fresh within
 * the enabling request itself, so the stale entry self-heals — while the
 * registry, which does NOT self-heal, is guarded.
 */
export async function observeNetworkStatus(
  pluginId: string,
  manifest: Pick<NetworkManifest, "exposure"> | undefined,
  status: NetworkStatus,
): Promise<void> {
  if (!ORIGIN_BEARING_STATES.has(status.state)) return;
  if (!isPluginEnabledSync(pluginId) || !resolvesPlugin(pluginId)) return;
  const record = await readNetworkState(pluginId);
  const next =
    fingerprint(record.addresses) === fingerprint(status.addresses)
      ? record
      : await writeNetworkState(pluginId, { addresses: status.addresses });
  // No await between this check and the write, and the disable's cache flip
  // precedes its forget — see the guard's doc above.
  if (!isPluginEnabledSync(pluginId) || !resolvesPlugin(pluginId)) return;
  originRegistry().setPluginOrigins(pluginId, originsOf(manifest, next));
}

/** Drops one plugin's contribution — a disabled, uninstalled or left network trusts nothing. */
export function forgetNetworkOrigins(pluginId: string): void {
  originRegistry().clearPlugin(pluginId);
}
