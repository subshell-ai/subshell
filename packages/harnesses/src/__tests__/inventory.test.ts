import { describe, expect, it } from "bun:test";
import type { HarnessPlugin } from "../index.js";
import { ALL_HARNESSES } from "../index.js";
import { scanHarnesses, scanOne } from "../inventory.js";

/** Minimal plugin whose probes are scripted per-test. */
function stubPlugin(
  overrides: Partial<Pick<HarnessPlugin, "isInstalled" | "findBinary" | "getVersion">>,
): HarnessPlugin {
  return {
    id: "stub",
    name: "Stub",
    binaryName: "stub",
    description: "",
    installHint: { command: "", docsUrl: "" },
    ttyRequired: true,
    enabledByDefault: true,
    isInstalled: async () => true,
    findBinary: async () => "/usr/bin/stub",
    getVersion: async () => "1.2.3",
    buildCommand: () => ["stub"],
    ...overrides,
  } as unknown as HarnessPlugin;
}

describe("scanHarnesses", () => {
  it("returns one entry per built-in harness with consistent optionals", async () => {
    const entries = await scanHarnesses();
    expect(entries.map((e) => e.harnessId).sort()).toEqual(ALL_HARNESSES.map((h) => h.id).sort());
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
});

describe("scanOne", () => {
  it("reports a clean installed entry with path + version", async () => {
    expect(await scanOne(stubPlugin({}))).toEqual({
      harnessId: "stub",
      installed: true,
      binaryPath: "/usr/bin/stub",
      version: "1.2.3",
    });
  });

  it("a rejecting isInstalled yields installed:false instead of failing the scan", async () => {
    const entry = await scanOne(
      stubPlugin({
        isInstalled: async () => {
          throw new Error("EACCES probing");
        },
      }),
    );
    expect(entry).toEqual({ harnessId: "stub", installed: false });
  });

  it("a rejecting findBinary/getVersion also degrades to installed:false", async () => {
    const throwing = async (): Promise<never> => {
      throw new Error("probe exploded");
    };
    expect(await scanOne(stubPlugin({ findBinary: throwing }))).toEqual({ harnessId: "stub", installed: false });
    expect(await scanOne(stubPlugin({ getVersion: throwing }))).toEqual({ harnessId: "stub", installed: false });
  });
});
