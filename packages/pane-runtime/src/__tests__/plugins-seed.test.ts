import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstalled, pluginsDir, uninstallPlugin } from "../plugins-dir.js";
import { seedBuiltIns } from "../plugins-seed.js";

/**
 * Without this, every existing node upgrades into offering nothing.
 *
 * `<dataDir>/plugins/` is the declaration and empty means "offers nothing", so
 * a node that has never had one needs its built-ins put there once. The whole
 * difficulty is doing that exactly once: a user who uninstalls everything must
 * not have it undone on the next restart.
 */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugins-seed-"));
}

describe("seedBuiltIns", () => {
  it("seeds every built-in when the plugins directory is absent", async () => {
    const dir = tempDataDir();
    const seeded = await seedBuiltIns(dir);
    expect(seeded.sort()).toEqual(["claude-code", "codex", "hermes", "opencode", "pi"]);
    expect((await listInstalled(dir)).length).toBe(5);
  });

  it("does NOTHING once a seed has COMPLETED, even with the directory emptied", async () => {
    // An empty directory is a user who uninstalled everything, and re-seeding
    // would undo that on every restart. The check used to be the directory's
    // existence, which looked equivalent and was not: `installEmbedded`
    // creates it before writing, so an interrupted first seed was skipped
    // forever. It is the completion marker instead.
    const dir = tempDataDir();
    await seedBuiltIns(dir);
    for (const p of await listInstalled(dir)) await uninstallPlugin(dir, p.id);

    expect(await seedBuiltIns(dir)).toEqual([]);
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("does not re-add a plugin the user uninstalled", async () => {
    const dir = tempDataDir();
    await seedBuiltIns(dir);
    await uninstallPlugin(dir, "codex");
    expect(await seedBuiltIns(dir)).toEqual([]);
    expect((await listInstalled(dir)).map((p) => p.id)).not.toContain("codex");
  });

  it("is idempotent across repeated boots", async () => {
    const dir = tempDataDir();
    await seedBuiltIns(dir);
    const after = (await listInstalled(dir)).map((p) => p.id);
    await seedBuiltIns(dir);
    await seedBuiltIns(dir);
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(after);
  });

  it("creates the directory even when there is nothing to put in it", async () => {
    // Otherwise the next boot would see an absent directory and seed again,
    // making "the user uninstalled everything" unreachable.
    const dir = tempDataDir();
    await seedBuiltIns(dir, []);
    expect(existsSync(pluginsDir(dir))).toBe(true);
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("seeds what it can when one built-in cannot be installed", async () => {
    // One bad plugin must not cost a node every other harness it could offer.
    const dir = tempDataDir();
    const seeded = await seedBuiltIns(dir, ["claude-code", "not-a-plugin", "pi"]);
    expect(seeded.sort()).toEqual(["claude-code", "pi"]);
  });
});

describe("a seed that was interrupted", () => {
  it("is retried, rather than leaving the node offering nothing forever", async () => {
    // `installEmbedded` creates the plugins directory before writing anything,
    // so keying on the directory meant a kill during the FIRST seed skipped
    // seeding for the rest of the node's life.
    const dir = tempDataDir();
    mkdirSync(pluginsDir(dir), { recursive: true });

    const seeded = await seedBuiltIns(dir, ["codex"]);
    expect(seeded).toEqual(["codex"]);
  });

  it("does not run again once it completed, even with everything uninstalled", async () => {
    // The other half, and the reason this is a marker rather than an
    // emptiness check: "I want nothing here" has to be reachable.
    const dir = tempDataDir();
    await seedBuiltIns(dir, ["codex"]);
    await uninstallPlugin(dir, "codex");

    expect(await seedBuiltIns(dir, ["codex"])).toEqual([]);
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("keeps its marker out of the plugin listing", async () => {
    const dir = tempDataDir();
    await seedBuiltIns(dir, ["codex"]);
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["codex"]);
  });
});
