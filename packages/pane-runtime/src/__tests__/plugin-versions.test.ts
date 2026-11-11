import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundledPluginVersion, installedCopyWins } from "../plugin-versions.js";

describe("installedCopyWins", () => {
  it("only a strictly newer installed version wins", () => {
    expect(installedCopyWins("1.2.0", "1.3.0")).toBe(true);
    expect(installedCopyWins("1.2.0", "1.2.0")).toBe(false);
    expect(installedCopyWins("1.2.0", "1.1.9")).toBe(false);
    expect(installedCopyWins("1.2.0", "")).toBe(false);
  });
});

describe("bundledPluginVersion", () => {
  it("reads the checkout copy of a built-in", async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../plugins/pi/package.json"), "utf8")) as {
      version: string;
    };
    expect(await bundledPluginVersion("pi")).toBe(pkg.version);
  });

  it("answers null for an id this build does not carry", async () => {
    expect(await bundledPluginVersion("no-such-plugin")).toBeNull();
  });
});
