import { scanHarnesses } from "@internal/harnesses";
import type { NodeEvent } from "@internal/session-protocol";

/** The `inventory` event shape (spec §3.3) — what the backend's `applyInventory` persists. */
export type InventoryEvent = Extract<NodeEvent, { type: "inventory" }>;

/**
 * Build one `inventory` event from a FRESH probe of every built-in harness on
 * THIS machine (`scanHarnesses` — control plane and agent run identical plugin
 * code against their own filesystems, spec §7).
 * @param nowMs - epoch-ms for the `ts` stamp (injectable for deterministic tests)
 * @returns a wire-valid inventory event (element shape mirrors HarnessInventoryEntry)
 */
export async function buildInventoryEvent(nowMs: number = Date.now()): Promise<InventoryEvent> {
  return {
    type: "inventory",
    harnesses: await scanHarnesses(),
    ts: new Date(nowMs).toISOString(),
  };
}
