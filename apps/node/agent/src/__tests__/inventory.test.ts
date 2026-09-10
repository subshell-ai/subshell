import { describe, expect, test } from "bun:test";
import { parseNodeEvent } from "@internal/subshell-protocol";
import { buildInventoryEvent } from "../inventory.js";

/**
 * The inventory event after the node lost its plugin concept (inversion spec
 * 2026-09-10 §6). There is no scan and no memo anymore — the event is the v2
 * wire's shape with no harness content: `harnesses: []` is protocol filler
 * the validator still requires, NOT a claim, and the server's `inventory`
 * handler treats an empty array as "nothing to apply" (pinned by the server's
 * detect-cache test in `apps/server/api/src/services/nodes/__tests__/
 * node-ws-handler.test.ts`).
 */

describe("buildInventoryEvent (post-inversion)", () => {
  test("empty harnesses, no plugins field, honest ts", async () => {
    const event = await buildInventoryEvent(1_700_000_000_000);
    expect(event).toEqual({ type: "inventory", harnesses: [], ts: new Date(1_700_000_000_000).toISOString() });
    // The plugins field is ABSENT, not empty: "no plugin concept" must not
    // arrive as the claim "this node offers nothing" either. The server
    // mirrors a PRESENT field only.
    expect("plugins" in event).toBe(false);
  });

  test("the event the dumb executor sends still parses on the server side", async () => {
    // The v2 validator requires the harnesses ARRAY (Task 8 moves the field);
    // this is the round trip the daemon's connect push actually takes.
    const event = await buildInventoryEvent();
    expect(parseNodeEvent(JSON.stringify(event))).toEqual(event);
  });

  test("ts defaults to wall clock", async () => {
    const before = Date.now();
    const event = await buildInventoryEvent();
    expect(Date.parse(event.ts)).toBeGreaterThanOrEqual(before - 1000);
  });
});
