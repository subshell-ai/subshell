import { describe, expect, it } from "bun:test";
import type { HarnessPlugin } from "../index.js";
import { allHarnesses } from "../index.js";
import { scanHarnesses, scanOne } from "../inventory.js";

/**
 * Minimal plugin whose probes are scripted per-test.
 *
 * `detect` is the one `scanOne` actually calls; `isInstalled` and `findBinary`
 * are here only so the object satisfies the interface. A stub that scripts
 * `isInstalled` and expects `scanOne` to notice is testing a call that no
 * longer happens, which is exactly what these tests used to do.
 */
function stubPlugin(overrides: Partial<HarnessPlugin>): HarnessPlugin {
  return {
    id: "stub",
    name: "Stub",
    binaryName: "stub",
    description: "",
    installHint: { command: "", docsUrl: "" },
    ttyRequired: true,
    enabledByDefault: true,
    detect: async () => ({ path: "/usr/bin/stub" }),
    isInstalled: async () => true,
    findBinary: async () => "/usr/bin/stub",
    getVersion: async () => "1.2.3",
    buildCommand: () => ["stub"],
    ...overrides,
  } as unknown as HarnessPlugin;
}

/** A fixed clock, so an expectation can name the stamp it wants. */
const AT = new Date("2026-09-09T12:00:00.000Z");
const AT_ISO = "2026-09-09T12:00:00.000Z";

describe("scanHarnesses", () => {
  it("returns one entry per built-in harness with consistent optionals", async () => {
    const entries = await scanHarnesses();
    expect(entries.map((e) => e.harnessId).sort()).toEqual(
      allHarnesses()
        .map((h) => h.id)
        .sort(),
    );
    for (const e of entries) {
      expect(typeof e.installed).toBe("boolean");
      if (!e.installed) {
        expect(e.version).toBeUndefined();
        expect(e.binaryPath).toBeUndefined();
      } else if (e.version !== undefined) {
        expect(typeof e.version).toBe("string");
      }
    }
  });

  it("gives one batch a single stamp", async () => {
    // The entries were probed together, so a reader comparing them must not
    // see them drift by milliseconds.
    for (const e of await scanHarnesses(AT)) expect(e.checkedAt).toBe(AT_ISO);
  });
});

describe("scanOne", () => {
  it("reports a clean installed entry with path, version and stamp", async () => {
    expect(await scanOne(stubPlugin({}), AT)).toEqual({
      harnessId: "stub",
      installed: true,
      binaryPath: "/usr/bin/stub",
      version: "1.2.3",
      checkedAt: AT_ISO,
    });
  });

  it("stamps a not-found entry and carries its reason", async () => {
    const entry = await scanOne(stubPlugin({ detect: async () => ({ path: null, reason: "not-on-path" }) }), AT);
    expect(entry).toEqual({ harnessId: "stub", installed: false, reason: "not-on-path", checkedAt: AT_ISO });
  });

  it("carries override-invalid through unchanged", async () => {
    const entry = await scanOne(stubPlugin({ detect: async () => ({ path: null, reason: "override-invalid" }) }), AT);
    expect(entry.reason).toBe("override-invalid");
  });

  it("a rejecting detect yields installed:false instead of failing the scan", async () => {
    const entry = await scanOne(
      stubPlugin({
        detect: async () => {
          throw new Error("EACCES probing");
        },
      }),
      AT,
    );
    // Stamped, but claiming NO reason: the probe failed, which is a different
    // thing from having looked and not found it.
    expect(entry).toEqual({ harnessId: "stub", installed: false, checkedAt: AT_ISO });
  });

  it("a rejecting getVersion also degrades to installed:false", async () => {
    const throwing = async (): Promise<never> => {
      throw new Error("probe exploded");
    };
    expect(await scanOne(stubPlugin({ getVersion: throwing }), AT)).toEqual({
      harnessId: "stub",
      installed: false,
      checkedAt: AT_ISO,
    });
  });

  it("omits version when the probe returns nothing, keeping the path", async () => {
    expect(await scanOne(stubPlugin({ getVersion: async () => null }), AT)).toEqual({
      harnessId: "stub",
      installed: true,
      binaryPath: "/usr/bin/stub",
      checkedAt: AT_ISO,
    });
  });
});
