import { type HarnessInventoryEntry, scanHarnesses } from "@internal/harnesses";
import type { NodeEvent } from "@internal/session-protocol";

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
 * Drop the scan memo. Test isolation only — suites that stub
 * `scanHarnesses` per-test must not inherit a previous probe.
 * @internal
 */
export function resetInventoryScanCache(): void {
  memo = null;
}

/**
 * Build one `inventory` event from a probe of every built-in harness on
 * THIS machine ({@link scanCoalesced} — control plane and agent run identical
 * plugin code against their own filesystems, spec §7).
 * @param nowMs - epoch-ms for the `ts` stamp (injectable for deterministic tests)
 * @param scan - probe override (tests); production leaves the {@link scanHarnesses} default
 * @returns a wire-valid inventory event (element shape mirrors HarnessInventoryEntry)
 */
export async function buildInventoryEvent(
  nowMs: number = Date.now(),
  scan: () => Promise<HarnessInventoryEntry[]> = scanHarnesses,
): Promise<InventoryEvent> {
  return {
    type: "inventory",
    harnesses: await scanCoalesced(nowMs, scan),
    ts: new Date(nowMs).toISOString(),
  };
}
