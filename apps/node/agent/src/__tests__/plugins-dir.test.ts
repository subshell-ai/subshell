import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEmbedded, listInstalled, pluginsDir, refreshStaleBuiltIns, uninstallPlugin } from "../plugins-dir.js";

/**
 * `<dataDir>/plugins/` IS the node's declaration of what it offers.
 *
 * That inverts `allowed-dirs`, where empty means unrestricted: an allowlist is
 * a restriction an owner opts into, while a plugin set is a positive statement
 * of what is installed. Empty here means "offers nothing", which is exactly
 * why the seeding step exists.
 */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugins-dir-"));
}

describe("the plugins directory", () => {
  it("an absent directory lists nothing, and is not created by reading", async () => {
    const dir = tempDataDir();
    expect(await listInstalled(dir)).toEqual([]);
    expect(existsSync(pluginsDir(dir))).toBe(false);
  });

  it("installs a built-in from the embedded copy, with no network", async () => {
    const dir = tempDataDir();
    const installed = await installEmbedded(dir, "claude-code");
    expect(installed.id).toBe("claude-code");
    expect(installed.manifest.name).toBe("Claude Code");
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["claude-code"]);
  });

  it("writes the files an install must write, and nothing else", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    const pkg = await readFile(join(pluginsDir(dir), "codex", "package.json"), "utf8");
    expect(JSON.parse(pkg).subshell.id).toBe("codex");
    expect(existsSync(join(pluginsDir(dir), "codex", "dist", "index.js"))).toBe(true);
  });

  it("installing twice is idempotent rather than an error", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    await installEmbedded(dir, "pi");
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["pi"]);
  });

  it("uninstall removes it and reports whether it was there", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    expect(await uninstallPlugin(dir, "codex")).toBe(true);
    expect(await uninstallPlugin(dir, "codex")).toBe(false);
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("lists several in a stable order", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    await installEmbedded(dir, "claude-code");
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["claude-code", "pi"]);
  });

  it("refuses an id that is not a safe path segment", async () => {
    // The id becomes a directory name, so `..` must never reach the filesystem.
    const dir = tempDataDir();
    for (const bad of ["../escape", "a/b", "", "."]) {
      await expect(installEmbedded(dir, bad)).rejects.toThrow();
      await expect(uninstallPlugin(dir, bad)).rejects.toThrow();
    }
  });

  it("refuses an unknown built-in, naming it", async () => {
    await expect(installEmbedded(tempDataDir(), "not-a-plugin")).rejects.toThrow(/not-a-plugin/);
  });

  it("a corrupt package.json lists as broken rather than vanishing", async () => {
    // Reported so a node page can say why, instead of the plugin silently
    // disappearing from every list.
    const dir = tempDataDir();
    await installEmbedded(dir, "hermes");
    await writeFile(join(pluginsDir(dir), "hermes", "package.json"), "{not json", "utf8");
    const [entry] = await listInstalled(dir);
    expect(entry?.id).toBe("hermes");
    expect(entry?.broken).toBeTruthy();
  });

  it("ignores a stray file in the plugins directory", async () => {
    const dir = tempDataDir();
    mkdirSync(pluginsDir(dir), { recursive: true });
    await writeFile(join(pluginsDir(dir), "README"), "not a plugin", "utf8");
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("refreshes an installed built-in this build has a newer copy of", async () => {
    // The binary and its built-ins ship together, so a stale on-disk copy is
    // never intentional: it means the agent was upgraded under it.
    const dir = tempDataDir();
    await installEmbedded(dir, "hermes");
    const pkgPath = join(pluginsDir(dir), "hermes", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const current = pkg.version;
    pkg.version = "0.0.1";
    await writeFile(pkgPath, JSON.stringify(pkg), "utf8");

    expect(await refreshStaleBuiltIns(dir)).toEqual(["hermes"]);
    expect(JSON.parse(await readFile(pkgPath, "utf8")).version).toBe(current);
  });

  it("refreshes nothing when every built-in is current", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    expect(await refreshStaleBuiltIns(dir)).toEqual([]);
  });

  it("leaves a plugin this build does not carry alone", async () => {
    // A third-party plugin has no embedded copy to compare against, and
    // overwriting it from nowhere would be a data-loss bug.
    const dir = tempDataDir();
    const foreign = join(pluginsDir(dir), "third-party");
    mkdirSync(foreign, { recursive: true });
    await writeFile(
      join(foreign, "package.json"),
      JSON.stringify({
        name: "third-party",
        version: "9.9.9",
        subshell: {
          apiVersion: 1,
          id: "third-party",
          type: "agent-harness",
          name: "Third Party",
          description: "not ours",
          entry: "index.js",
        },
      }),
      "utf8",
    );
    await writeFile(join(foreign, "index.js"), "export default () => ({});", "utf8");
    expect(await refreshStaleBuiltIns(dir)).toEqual([]);
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["third-party"]);
  });
});
