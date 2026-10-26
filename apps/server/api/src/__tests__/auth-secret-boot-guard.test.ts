import { describe, expect, it } from "bun:test";
import { assertProdAuthSecret, PLACEHOLDER_AUTH_SECRET } from "@/constants.js";

/**
 * F1 (security audit 2026-08): better-auth's own prod guard only rejects its
 * OWN default secret string, so our baked-in placeholder would boot silently
 * in production and sign cookies with a publicly known key. The boot guard in
 * `src/index.ts` must hard-fail on exactly that combination: production +
 * placeholder. Dev and test keep the placeholder default.
 */
describe("production placeholder-secret boot guard", () => {
  it("production + placeholder secret refuses to boot, naming BETTER_AUTH_SECRET", () => {
    expect(() => assertProdAuthSecret(true, PLACEHOLDER_AUTH_SECRET)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("production + a real secret boots fine", () => {
    expect(() => assertProdAuthSecret(true, "a-real-secret-that-is-long-enough-0123456789")).not.toThrow();
  });

  it("dev/test + placeholder boots fine (the default stays usable outside prod)", () => {
    expect(() => assertProdAuthSecret(false, PLACEHOLDER_AUTH_SECRET)).not.toThrow();
  });
});
