/**
 * Screen-preview cache for AGENT-node sessions (spec 2026-08-31 §6.3).
 *
 * The session list renders a preview per card, and the local path captures
 * each pane straight from tmux. On an agent node a capture is a signed
 * round-trip — the list endpoint must never fan one out per card. Instead the
 * reconcile sweep's batched `probe` rides opportunistic screen captures back
 * to the control plane (the agent drops them wholesale when the batch answer
 * would bust its frame budget), and this module is where they wait for the
 * next list read: `previewCachePut` from the sweep, `previewCacheGet` from
 * `#preview` — cache-only, no network on the list path.
 *
 * Freshness is the sweep's cadence, so the TTL matches it: an entry older
 * than {@link PREVIEW_CACHE_TTL_MS} expired on read and is dropped. Expiry is
 * checked with an injectable clock so tests never sleep.
 */

/** How long a cached preview stays readable (matches the 60 s sweep cadence). */
export const PREVIEW_CACHE_TTL_MS = 60_000;

/** One cached screen with the stamp of when it was stored. */
interface CacheEntry {
  /** The already-tail-trimmed screen lines (what `#preview` returns). */
  lines: string[];
  /** `Date.now()` at write time — measured against the reader's clock. */
  stampedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Stores one session's latest screen (from a probe `capture` entry).
 * @param id - session id
 * @param lines - the tail-trimmed screen lines to serve until the next write or expiry
 */
export function previewCachePut(id: string, lines: string[]): void {
  cache.set(id, { lines, stampedAt: Date.now() });
}

/**
 * Reads one session's cached screen, expiring stale entries on read.
 * @param id - session id
 * @param now - clock for the TTL comparison (defaults to wall time; injectable for tests)
 * @returns the cached lines, or undefined when absent or older than the TTL
 */
export function previewCacheGet(id: string, now: number = Date.now()): string[] | undefined {
  const hit = cache.get(id);
  if (!hit) return undefined;
  if (now - hit.stampedAt > PREVIEW_CACHE_TTL_MS) {
    cache.delete(id); // expire-on-read: the dead entry never resurfaces
    return undefined;
  }
  return hit.lines;
}

/**
 * Drops one session's cached preview — called on the death transition so a
 * dead pane's last screen never outlives its row's alive state.
 * @param id - session id
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
