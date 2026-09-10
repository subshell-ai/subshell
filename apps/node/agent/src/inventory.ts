import type { NodeEvent } from "@internal/subshell-protocol";

/** The `inventory` event shape (spec §3.3) — what the backend's `applyInventory` persists. */
export type InventoryEvent = Extract<NodeEvent, { type: "inventory" }>;

/**
 * Build the `inventory` event. After the inversion (spec 2026-09-10 §6) the
 * node holds no plugin concept, so there is nothing left to scan: the event
 * is protocol filler it still owes the wire.
 *
 * `harnesses: []` is the shape the validator requires (the array itself is
 * non-optional even at protocol 3 — it was the `plugins` field that left the
 * wire, not this one), NOT a claim that no harness binary exists here. The
 * server is told so: its `inventory` handler treats an EMPTY array as
 * "nothing to apply" and never overwrites the detection rows the plane itself
 * collected via the `detect` command (inversion §4) — pinned by
 * `apps/server/api/src/services/nodes/__tests__/node-ws-handler.test.ts`.
 * The honest facts this machine still offers —
 * binary presence and version text — travel as `detect` ANSWERS, built from
 * the plane's own plugin rules, and the pane census travels as
 * `subshells_report`. The old scan memo that used to live here coalesced
 * PATH walks over installed plugins; with no scan there is nothing to
 * coalesce, and the periodic cadence (daemon.ts) now costs a constant.
 */
export async function buildInventoryEvent(nowMs: number = Date.now()): Promise<InventoryEvent> {
  return { type: "inventory", harnesses: [], ts: new Date(nowMs).toISOString() };
}
