import { describe, expect, test } from "bun:test";
import { getAuth, resetAuthForTests } from "@/auth.js";

/**
 * The lazy-auth contract (spec 2026-09-03 §2): better-auth construction is
 * the graph's only import-time IO (its constructor opens SQLite), so it must
 * happen on FIRST USE, never at module evaluation. These tests run under
 * SUBSHELL_TEST_MODE (bunfig preload) with the per-process temp DB.
 */
describe("getAuth", () => {
  test("is memoized: the same instance on every call", () => {
    const a = getAuth();
    expect(a).toBe(getAuth());
  });

  test("resetAuthForTests drops the memo (test isolation seam)", () => {
    const a = getAuth();
    resetAuthForTests();
    expect(getAuth()).not.toBe(a);
  });
});
