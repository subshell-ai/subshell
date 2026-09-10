import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstalled, pluginsDir, uninstallPlugin } from "../plugins-dir.js";
import { prepareInstalledPlugins, seedBuiltIns } from "../plugins-seed.js";

/**
 * Without the boot prepare, an instance store that has never existed would
 * upgrade into offering nothing.
 *
 * `<SUBSHELL_SERVER_DATA_DIR>/plugins/` is the instance declaration and empty
 * means "the operator uninstalled everything", so a store that has never
 * completed a seed needs its built-ins put there once. The whole difficulty is
 * doing that exactly once: an emptied directory must not be re-seeded on the
 * next restart. (Spec 2026-09-10 moved the store from nodes to the control
 * plane; the seed mechanics were already node-free.)
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

describe("prepareInstalledPlugins", () => {
  it("resolves even when a guarded step fails on an unopenable store", async () => {
    // The boot contract depends on this function being TOTAL: the server's
    // `prepareLocalPlugins` syncs the registry overlay after it, so an
    // unresolvable disk must still leave every loadable plugin resolved and
    // must never reject up into the boot. A `<dir>/plugins` path that is a
    // regular FILE is the instrument, and MEASUREMENT says which step proves
    // the guard: `seedBuiltIns` reaches it and its own `mkdir` throws EEXIST,
    // so the pass only resolves because the per-step catch absorbs that
    // (without the guard this call would reject). `recoverInterruptedInstalls`
    // and `refreshStaleBuiltIns` swallow the same unreadable directory one
    // level lower, in `plugins-dir`, and resolve quietly. One step reaching
    // the outer guard is enough to pin totality; the pass completing for all
    // three is the assertion.
    const dir = tempDataDir();
    writeFileSync(join(dir, "plugins"), "not a directory");
    await expect(prepareInstalledPlugins(dir)).resolves.toBeUndefined();
  });

  it("is the same pass through when the directory is merely absent", async () => {
    // A never-seen store is the ordinary first boot, not an error: the pass
    // must complete and leave the seed marker behind.
    const parent = tempDataDir();
    const dir = join(parent, "fresh-home");
    mkdirSync(dir);
    await expect(prepareInstalledPlugins(dir)).resolves.toBeUndefined();
    expect(await listInstalled(dir)).toHaveLength(5);
  });
});
