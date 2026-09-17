import type { NetworkManifest, NetworkStatus } from "@internal/pane-runtime";
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
 */
export async function observeNetworkStatus(
  pluginId: string,
  manifest: Pick<NetworkManifest, "exposure"> | undefined,
  status: NetworkStatus,
): Promise<void> {
  if (!ORIGIN_BEARING_STATES.has(status.state)) return;
  const record = await readNetworkState(pluginId);
  const next =
    fingerprint(record.addresses) === fingerprint(status.addresses)
      ? record
      : await writeNetworkState(pluginId, { addresses: status.addresses });
  originRegistry().setPluginOrigins(pluginId, originsOf(manifest, next));
}

/** Drops one plugin's contribution — a disabled, uninstalled or left network trusts nothing. */
export function forgetNetworkOrigins(pluginId: string): void {
  originRegistry().clearPlugin(pluginId);
}
