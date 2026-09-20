/**
 * Screen-preview cache for the subshell list (spec 2026-08-31 §6.3).
 *
 * The subshell list renders a preview per card, and one card's screen costs
 * something different per row kind:
 *
 * - **Agent rows**: a capture is a signed round-trip, so the list endpoint
 *   must never fan one out per card. The reconcile sweep's batched `probe`
 *   rides opportunistic screen captures back to the control plane (the agent
 *   drops them wholesale when the batch answer would bust its frame budget),
 *   and this module is where they wait for the next list read:
 *   `previewCachePut` from the sweep, `previewCacheGet` from `#preview` —
 *   cache-only, no network on the list path.
 * - **Local rows**: a capture is a tmux spawn (measured ~3 ms), cheap per
 *   call but repeated per CONSUMER — every open tab's `/api/events` feed
 *   rebuilds the whole list on its own 1.5 s tick, and the REST list reads
 *   add more. The cache is what stops N consumers costing N captures per
 *   pane: `#preview` reads through it and writes what it captured, so a
 *   pane costs one capture per TTL window however many feeds and routes
 *   ask for it.
 *
 * Freshness therefore differs by kind, which is why the TTL is PER ENTRY
 * ({@link previewCachePut}'s third argument): agent entries live for the
 * sweep's cadence ({@link PREVIEW_CACHE_TTL_MS} — a miss waits for the next
 * sweep by design), local entries for the feed's ({@link LOCAL_PREVIEW_TTL_MS}
 * — long enough to dedupe the tabs reading the same moment, short enough not
 * to age the preview the feed exists to deliver). An entry older than its own
 * TTL expires on read and is dropped. Expiry is checked with an injectable
 * clock so tests never sleep.
 */

/** How long an agent preview stays readable (matches the 60 s sweep cadence). */
export const PREVIEW_CACHE_TTL_MS = 60_000;

/**
 * How long a locally captured preview stays readable. Matches the SSE feed's
 * 1.5 s frame interval rounded up: the dedupe window, not a freshness
 * promise. Longer and the home page's previews visibly lag; shorter and two
 * tabs ticking a few hundred ms apart both capture again.
 */
export const LOCAL_PREVIEW_TTL_MS = 2_000;

/** One cached screen with the stamp of when it was stored. */
interface CacheEntry {
  /** The already-tail-trimmed screen lines (what `#preview` returns). */
  lines: string[];
  /** `Date.now()` at write time — measured against the reader's clock. */
  stampedAt: number;
  /** How long THIS entry stays readable — agent writes and local writes differ. */
  ttlMs: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Stores one subshell's latest screen (from a probe `capture` entry, or from
 * a local tmux capture).
 * @param id - subshell id
 * @param lines - the tail-trimmed screen lines to serve until the next write or expiry
 * @param ttlMs - how long the entry stays readable (default: the sweep's cadence,
 *   which is what an agent capture waits out; local writes pass {@link LOCAL_PREVIEW_TTL_MS})
 */
export function previewCachePut(id: string, lines: string[], ttlMs: number = PREVIEW_CACHE_TTL_MS): void {
  cache.set(id, { lines, stampedAt: Date.now(), ttlMs });
}

/**
 * Reads one subshell's cached screen, expiring stale entries on read.
 * @param id - subshell id
 * @param now - clock for the TTL comparison (defaults to wall time; injectable for tests)
 * @returns the cached lines, or undefined when absent or older than the entry's own TTL
 */
export function previewCacheGet(id: string, now: number = Date.now()): string[] | undefined {
  const hit = cache.get(id);
  if (!hit) return undefined;
  if (now - hit.stampedAt > hit.ttlMs) {
    cache.delete(id); // expire-on-read: the dead entry never resurfaces
    return undefined;
  }
  return hit.lines;
}

/**
 * Drops one subshell's cached preview — called on the death transition so a
 * dead pane's last screen never outlives its row's alive state.
 * @param id - subshell id
 */
export function previewCacheDrop(id: string): void {
  cache.delete(id);
}

/**
 * Empties the whole cache. Test seam only — production callers must not call
 * this; @internal.
 */
export function resetPreviewCacheForTests(): void {
  cache.clear();
}
