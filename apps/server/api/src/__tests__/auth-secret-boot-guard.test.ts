import { describe, expect, it } from "bun:test";
import { assertProdAuthSecret, IS_PROD, PLACEHOLDER_AUTH_SECRET } from "@/constants.js";

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

  it("production + a merely-different secret boots fine (only the placeholder is fatal)", () => {
    expect(() => assertProdAuthSecret(true, "some-other-secret-value-0123456789")).not.toThrow();
  });

  it("dev/test + placeholder boots fine (the default stays usable outside prod)", () => {
    expect(() => assertProdAuthSecret(false, PLACEHOLDER_AUTH_SECRET)).not.toThrow();
  });

  it("the test suite itself never trips the guard (IS_PROD is false)", () => {
    // If this ever fails, `bun test` would be exercising the prod path and the
    // guard would abort every developer's suite. Deliberately does NOT assert
    // AUTH_SECRET === placeholder: a developer's `.env` may set a real secret.
    expect(IS_PROD).toBe(false);
    expect(() => assertProdAuthSecret()).not.toThrow();
    // …and even a placeholder secret is only fatal under isProd=true.
    expect(() => assertProdAuthSecret(IS_PROD, PLACEHOLDER_AUTH_SECRET)).not.toThrow();
  });
});
