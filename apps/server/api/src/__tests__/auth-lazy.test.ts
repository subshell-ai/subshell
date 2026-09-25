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

  test("a zero-provider table still builds: no genericOAuth plugin over an email-only auth_providers", () => {
    // Task 4's regression: AUTH_OPTIONS must keep working untouched by the
    // provider wiring, and the lone EMAIL row (kind "email") is a provider for POLICY
    // only — buildAuth filters it, so genericOAuth never enters the plugin
    // list at all when no oidc/google row exists.
    resetAuthForTests();
    const auth = getAuth();
    const pluginIds = ((auth.options?.plugins ?? []) as { id?: string }[]).map((p) => p.id);
    expect(pluginIds).not.toContain("generic-oauth");
    expect(typeof auth.handler).toBe("function");
  });
});
