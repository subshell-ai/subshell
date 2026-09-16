import type { NetworkContext, NetworkPluginEntry, RequestGuardSpec } from "@internal/pane-runtime";
import { getLogger } from "@/utils/logger.js";

/**
 * Asking one plugin what front-door check its traffic needs — from ONE place.
 *
 * There used to be two sources for this. A publish returned a guard in its
 * `PublishOutcome` and the route installed that; boot called `requestGuard`
 * and installed what it returned. A plugin that produced its guard only at
 * publish time was therefore guarded by the route and UNGUARDED after any
 * restart, and nothing anywhere refused that shape. The two sources also met
 * in the port reconcile, where the outcome's guard was silently dropped.
 *
 * So the outcome no longer carries one. `requestGuard(ctx)` is the single
 * source, asked by whoever needs the answer, and this module is that asking:
 * the route and the boot pass call the same function so a throwing or
 * null-returning guard folds the same three ways in both. Hand-writing a
 * second copy is exactly how they diverged the first time — the same reasoning
 * that keeps `unpublishNetwork` one function with one ordering.
 *
 * The shape this deliberately makes impossible is a guard whose value is
 * discovered BY the publish act (an ephemeral tunnel hostname assigned at
 * connect time, say). That shape was already broken: such a guard is wrong the
 * moment the supervised process respawns with a different hostname, so storing
 * it would persist a value stale after exactly the event the storage existed
 * for. When it becomes real, the answer is a stored publish RECORD — facts the
 * plugin observed, handed back on `NetworkContext`, with `requestGuard` still
 * re-deriving from them — because an observation survives a respawn where a
 * decision does not.
 */

/** What one plugin's guard question answered. */
export interface ResolvedGuard {
  /** What the plugin declares right now, or null for any reason at all. */
  guard: RequestGuardSpec | null;
  /**
   * True when this exposure requires a guard and none was produced.
   *
   * ANY reason: the member is absent, it returned null, it threw. They are one
   * rule — for an exposure whose guard IS the perimeter, no guard means the
   * thing it guards may not run — and treating them separately is what let two
   * of the three through before.
   */
  refused: boolean;
}

/**
 * Whether this plugin's exposure makes a request guard mandatory.
 *
 * Manifest data, read without loading plugin code: `public-with-gate` means
 * publishing reaches the open internet with an identity check in front. The
 * check IS the perimeter there, so running without one is the whole risk the
 * exposure label exists to bound.
 */
export function needsGuard(entry: NetworkPluginEntry): boolean {
  return entry.manifest.network?.exposure === "public-with-gate";
}

/**
 * Asks a plugin for its guard, folding every way of not having one.
 *
 * Never throws: a plugin failing to describe its guard is an answer this host
 * acts on, not an exception for a caller to handle. It does NOT undo a
 * publish either — that is the admin's standing decision, and what failed is
 * this host's attempt to honour it.
 * @param entry - the plugin and its manifest
 * @param ctx - the context to ask through; rebuild it after any state write
 */
export function resolveNetworkGuard(entry: NetworkPluginEntry, ctx: NetworkContext): ResolvedGuard {
  const required = needsGuard(entry);
  if (!entry.plugin.requestGuard) return { guard: null, refused: required };
  try {
    const guard = entry.plugin.requestGuard(ctx);
    return { guard: guard ?? null, refused: required && !guard };
  } catch (err) {
    getLogger().withError(err).warn(`network plugin "${entry.manifest.id}" failed to describe its request guard`);
    return { guard: null, refused: required };
  }
}
