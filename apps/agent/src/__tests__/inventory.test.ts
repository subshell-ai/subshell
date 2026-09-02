import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildInventoryEvent, INVENTORY_SCAN_MEMO_MS, resetInventoryScanCache } from "../inventory.js";

/**
 * The scan memo (P3 /simplify): connect push + §5.3 pull + cadence can land
 * within a second of each other; each full probe spawns `<binary> --version`
 * per installed harness, so the SCAN coalesces while every caller still gets
 * its own `ts`-stamped event. These tests inject the scan seam — no PATH
 * probes, no module mocks.
 */

function countingScan(harnesses: [] = []) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    scan: async () => {
      calls += 1;
      return harnesses;
    },
  };
}

// The memo is module-global and `bun test` shares one process across files:
// earlier files (daemon/basics) leave an EPOCH-scale memo that these
// tiny-`nowMs` vectors would otherwise hit. Reset on BOTH sides of every test.
beforeEach(() => {
  resetInventoryScanCache();
});
afterEach(() => {
  resetInventoryScanCache();
});

describe("buildInventoryEvent scan memo", () => {
  test("two calls inside the window share ONE scan; events keep per-call stamps", async () => {
    const s = countingScan();
    const a = await buildInventoryEvent(1_000, s.scan);
    const b = await buildInventoryEvent(1_000 + INVENTORY_SCAN_MEMO_MS - 1, s.scan);
    expect(s.calls).toBe(1);
    expect(a.ts).toBe(new Date(1_000).toISOString());
    expect(b.ts).toBe(new Date(1_000 + INVENTORY_SCAN_MEMO_MS - 1).toISOString());
  });

  test("concurrent calls coalesce in flight", async () => {
    const s = countingScan();
    const [a, b] = await Promise.all([buildInventoryEvent(5_000, s.scan), buildInventoryEvent(5_000, s.scan)]);
    expect(s.calls).toBe(1);
    expect(a.harnesses).toBe(b.harnesses);
  });

  test("past the window the next call re-scans", async () => {
    const s = countingScan();
    await buildInventoryEvent(0, s.scan);
    await buildInventoryEvent(INVENTORY_SCAN_MEMO_MS, s.scan);
    expect(s.calls).toBe(2);
  });

  test("a failed scan is never memoized", async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("probe exploded");
    };
    await expect(buildInventoryEvent(0, failing)).rejects.toThrow("probe exploded");
    await expect(buildInventoryEvent(1, failing)).rejects.toThrow("probe exploded");
    expect(calls).toBe(2);
    // recovery: the first success after failures memoizes normally
    const s = countingScan();
    await buildInventoryEvent(2, s.scan);
    await buildInventoryEvent(3, s.scan);
    expect(s.calls).toBe(1);
  });

  test("resetInventoryScanCache forces the next call to re-scan", async () => {
    const s = countingScan();
    await buildInventoryEvent(0, s.scan);
    resetInventoryScanCache();
    await buildInventoryEvent(1, s.scan);
    expect(s.calls).toBe(2);
  });
});
