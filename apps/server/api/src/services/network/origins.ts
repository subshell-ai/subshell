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
 * The loadability oracle {@link observeNetworkStatus} consults, behind a
 * seam. Loadability is the guard for a THIRD-PARTY plugin's uninstall:
 * `uninstallLocalPlugin` refreshes the overlay, and after that the answer is
 * false forever. It is NOT the guard for a BUILT-IN's uninstall — the four
 * compiled-in network plugins answer `getNetworkPlugin` from the static
 * import set permanently, bytes on disk or not — which is what
 * {@link tombstoneNetworkPlugin} exists for, and the reason the route
 * unconditionally declares the tombstone beside the forget.
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
 * The network plugins UNINSTALLED since this process booted.
 *
 * The third of the three guards, and the only one that can see a BUILT-IN's
 * uninstall. Neither of the others can: `getNetworkPlugin` answers the four
 * compiled-in network plugins forever, and uninstall clears the
 * `plugin_state` row, whose absent default is ENABLED. A probe in flight
 * during a tailscale uninstall therefore passes both defaults and, left to
 * itself, recreates the just-deleted `network.json` and re-trusts its
 * addresses for the life of the process. The tombstone is explicit durable
 * state surviving both fail-open defaults: the delete route sets it inside
 * the lock BEFORE its forget, so every observation reaching either guard
 * point afterwards refuses. A REINSTALL lifts it
 * ({@link liftNetworkPluginTombstone}) and the plugin re-earns trust through
 * a fresh observation like any other install — the record is gone, so
 * nothing stale survives the tombstone's lifetime.
 */
const tombstones = new Set<string>();

/** Declares a plugin uninstalled: no observation may re-learn it. The delete route calls it inside the lock, before the forget. */
export function tombstoneNetworkPlugin(pluginId: string): void {
  tombstones.add(pluginId);
}

/** Forgets the declaration — a (re)install re-earns trust through fresh observation. */
export function liftNetworkPluginTombstone(pluginId: string): void {
  tombstones.delete(pluginId);
}

/** The guard's synchronous read, exported so the uninstall route's tests can pin WHEN the declaration lands. */
export function isNetworkPluginTombstoned(pluginId: string): boolean {
  return tombstones.has(pluginId);
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

/** The three guard questions, as one synchronous answer: disabled, uninstalled or tombstoned — refuse. */
function refused(pluginId: string): boolean {
  return !isPluginEnabledSync(pluginId) || !resolvesPlugin(pluginId) || isNetworkPluginTombstoned(pluginId);
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
 * **THE THREE GUARDS — a forget must survive the probe already in flight.**
 * The refresher and the page's list read capture their plugin list, then
 * await a multi-second `status()`; a disable or an uninstall can complete in
 * between, and its `forgetNetworkOrigins` must not be undone by this
 * function's return. Three synchronous questions at both points below — a
 * plugin the operator stopped being observed at all, with no record write and
 * no trust:
 *
 * - `isPluginEnabledSync` — DISABLE. The disable route flips the flag
 *   synchronously BEFORE its forget, so a check answering `true` at the final
 *   point proves the forget has not run yet; the write lands this same
 *   synchronous turn, before it, and the forget wins.
 * - `resolvesPlugin` — a THIRD-PARTY UNINSTALL. The overlay refresh makes the
 *   answer false forever; no later probe writes. Built-ins are invisible to
 *   this guard (the compiled set always answers), which is exactly why the
 *   next one exists.
 * - `isTombstoned` — a BUILT-IN'S UNINSTALL, and the durable state the other
 *   two structurally miss: built-ins always resolve, and an uninstalled
 *   plugin's cleared row reads as enabled. The delete route declares the
 *   tombstone inside the lock BEFORE its forget — the disable's ordering, one
 *   guard over — so the same no-await argument covers it, and a reinstall
 *   lifts it so the plugin re-earns trust through a fresh observation.
 *
 * The final point runs with NO await between check and write, at all three
 * questions; that is what makes it airtight for the registry, the thing that
 * accepts sign-ins. (The enabled view's entry read is fail-open on a cold
 * cache, but every production path that probes hydrates it via
 * `stateByPluginId` first, and the final point carries the safety either
 * way.)
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
  if (refused(pluginId)) return;
  const record = await readNetworkState(pluginId);
  const next =
    fingerprint(record.addresses) === fingerprint(status.addresses)
      ? record
      : await writeNetworkState(pluginId, { addresses: status.addresses });
  // No await between this check and the write; every durable state
  // (flag, overlay, tombstone) lands before its forget — see the doc above.
  if (refused(pluginId)) return;
  originRegistry().setPluginOrigins(pluginId, originsOf(manifest, next));
}

/** Drops one plugin's contribution — a disabled, uninstalled or left network trusts nothing. */
export function forgetNetworkOrigins(pluginId: string): void {
  originRegistry().clearPlugin(pluginId);
}
