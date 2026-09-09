import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBinaryWithOptions } from "../binary-lookup.js";
import { versionManagerBins } from "../version-manager-paths.js";

/**
 * The case a static list of known paths cannot express: nvm's directories
 * carry a node version, so the only way to name them is to glob.
 */
describe("versionManagerBins", () => {
  /** A fake HOME with one nvm-style node install holding `name`. */
  function homeWithNvm(versions: string[], name: string): string {
    const home = mkdtempSync(join(tmpdir(), "vm-home-"));
    for (const v of versions) {
      const bin = join(home, ".nvm/versions/node", v, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, name), "#!/bin/sh\n");
      chmodSync(join(bin, name), 0o755);
    }
    return home;
  }

  it("finds an nvm bin directory", async () => {
    const home = homeWithNvm(["v22.6.0"], "claude");
    const dirs = await versionManagerBins(home);
    expect(dirs).toContain(join(home, ".nvm/versions/node/v22.6.0/bin"));
  });

  it("orders multiple node versions newest first", async () => {
    const home = homeWithNvm(["v18.20.4", "v22.6.0", "v20.11.0"], "claude");
    const dirs = await versionManagerBins(home);
    const nvm = dirs.filter((d) => d.includes(".nvm"));
    expect(nvm[0]).toBe(join(home, ".nvm/versions/node/v22.6.0/bin"));
    expect(nvm[1]).toBe(join(home, ".nvm/versions/node/v20.11.0/bin"));
    expect(nvm[2]).toBe(join(home, ".nvm/versions/node/v18.20.4/bin"));
  });

  it("always offers the stable manager directories", async () => {
    const home = mkdtempSync(join(tmpdir(), "vm-empty-"));
    const dirs = await versionManagerBins(home);
    expect(dirs).toContain(join(home, ".volta/bin"));
    expect(dirs).toContain(join(home, ".asdf/shims"));
    expect(dirs).toContain(join(home, ".local/share/mise/shims"));
  });

  it("answers empty-ish for a HOME that does not exist", async () => {
    const dirs = await versionManagerBins(join(tmpdir(), `absent-${crypto.randomUUID()}`));
    expect(Array.isArray(dirs)).toBe(true);
  });
});

describe("the lookup consults version managers", () => {
  it("finds a harness installed under nvm with nothing on PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "vm-lookup-"));
    const bin = join(home, ".nvm/versions/node/v22.6.0/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(bin, "claude"), 0o755);

    // This is the reported bug in one assertion: a service PATH with no nvm
    // entry, a HOME with no known location, and the binary sitting exactly
    // where the official npm install route puts it.
    const result = await detectBinaryWithOptions("claude", "CLAUDE_PATH", [".local/bin/claude"], {
      env: { HOME: home },
      pathEntries: ["/usr/bin", "/bin"],
    });
    expect(result.path).toBe(join(bin, "claude"));
    expect(result.reason).toBeUndefined();
  });
});
