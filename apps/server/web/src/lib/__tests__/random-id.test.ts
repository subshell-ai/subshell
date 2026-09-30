import { describe, expect, it } from "bun:test";
import { newRandomId } from "../random-id";

/**
 * The origin-proof id (2026-09-29): `crypto.randomUUID` is absent on plain
 * http LAN origins, and a call that assumes it crashed the subshell page
 * and deadened the picker's clicks there. The fallback must exist, be
 * unique-enough for its callers, and never throw.
 */

describe("newRandomId", () => {
  it("answers in a NON-secure context, where crypto.randomUUID is absent", () => {
    const cryptoAny = globalThis.crypto as { randomUUID?: unknown };
    const real = cryptoAny.randomUUID;
    Object.defineProperty(cryptoAny, "randomUUID", { value: undefined, configurable: true });
    try {
      const a = newRandomId("s");
      const b = newRandomId("s");
      expect(a.startsWith("s-")).toBe(true);
      expect(a === b).toBe(false);
    } finally {
      delete cryptoAny.randomUUID;
      if (real !== undefined) Object.defineProperty(cryptoAny, "randomUUID", { value: real, configurable: true });
    }
  });

  it("uses the real uuid where the platform provides one", () => {
    expect(newRandomId().length).toBeGreaterThanOrEqual(36);
  });
});
