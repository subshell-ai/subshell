import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    expect(seeded.sort()).toEqual([
      "claude-code",
      "cloudflare-tunnel",
      "codex",
      "hermes",
      "opencode",
      "pi",
      "tailscale",
      "terminal",
    ]);
    expect((await listInstalled(dir)).length).toBe(8);
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
    // An empty-ids pass records `[]` — "nothing seeded YET", not "nothing
    // ever", which is why a later default pass still seeds. The operator's
    // "I want nothing here" is the UNINSTALL path instead (the id stays in the
    // record after it leaves the disk, pinned below); this case only proves
    // the pass is total when there is nothing to do.
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

describe("seeding a store that has already been seeded", () => {
  it("installs a built-in the store has never seen, and only that one", async () => {
    const dir = tempDataDir();
    await seedBuiltIns(dir, ["claude-code", "codex"]);

    const second = await seedBuiltIns(dir, ["claude-code", "codex", "terminal"]);

    expect(second).toEqual(["terminal"]);
    expect((await listInstalled(dir)).map((p) => p.id).sort()).toEqual(["claude-code", "codex", "terminal"]);
  });

  it("never resurrects a built-in the operator uninstalled", async () => {
    const dir = tempDataDir();
    await seedBuiltIns(dir, ["claude-code", "codex"]);
    await uninstallPlugin(dir, "codex");

    const second = await seedBuiltIns(dir, ["claude-code", "codex"]);

    // Seeded once, so it is in the record and never seeded again. This is
    // the property the original boolean marker existed to protect.
    expect(second).toEqual([]);
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["claude-code"]);
  });

  it("treats a legacy marker as the five pre-terminal built-ins", async () => {
    const dir = tempDataDir();
    const root = pluginsDir(dir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // What the old code wrote: a timestamp, not JSON.
    writeFileSync(join(root, ".seeded"), `${new Date().toISOString()}\n`, { mode: 0o600 });

    const seeded = await seedBuiltIns(dir, ["claude-code", "codex", "terminal"]);

    // An instance upgrading from before this change gains the new built-in
    // and nothing else, whatever it had uninstalled.
    expect(seeded).toEqual(["terminal"]);
  });

  it("records ids as JSON so a later pass can read them", async () => {
    const dir = tempDataDir();
    await seedBuiltIns(dir, ["claude-code"]);

    const raw = readFileSync(join(pluginsDir(dir), ".seeded"), "utf8");

    expect(JSON.parse(raw)).toEqual(["claude-code"]);
  });

  it("touches NOTHING on the ordinary boot of a fully seeded store", async () => {
    // The steady state is every existing instance's every boot. The
    // pre-record code returned early there and so must this one: a store on
    // read-only or root-owned media keeps booting on what it has, where an
    // unconditional mkdir/chmod/write pair would warn every boot and bury the
    // warnings that matter.
    const dir = tempDataDir();
    await seedBuiltIns(dir, ["claude-code", "codex"]);
    const before = statSync(join(pluginsDir(dir), ".seeded")).mtimeMs;

    expect(await seedBuiltIns(dir, ["claude-code", "codex"])).toEqual([]);

    expect(statSync(join(pluginsDir(dir), ".seeded")).mtimeMs).toBe(before);
  });
});

describe("a seed marker this code cannot read", () => {
  function corruptMarker(dir: string, content: string): string {
    const root = pluginsDir(dir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const marker = join(root, ".seeded");
    writeFileSync(marker, content, { mode: 0o600 });
    return marker;
  }

  it("stops the pass on an empty marker and leaves the file untouched", async () => {
    // Empty is not the legacy shape (the pre-record code always wrote a
    // timestamp); it is a torn write or an operator clearing the file.
    // Guessing either way would PERSIST the guess as the durable record —
    // including resurrecting an uninstalled built-in permanently.
    const dir = tempDataDir();
    const marker = corruptMarker(dir, "");

    expect(await seedBuiltIns(dir, ["claude-code", "terminal"])).toEqual([]);

    expect(readFileSync(marker, "utf8")).toBe("");
    expect(await listInstalled(dir)).toEqual([]);
  });

  it("stops the pass on content no version of this code wrote", async () => {
    // Neither JSON ids nor a leading-date timestamp: tampering or a shape
    // from some other tool. Same rule: no write over what cannot be read.
    const dir = tempDataDir();
    const marker = corruptMarker(dir, "who-knows-what-this-is\n");

    expect(await seedBuiltIns(dir, ["claude-code"])).toEqual([]);

    expect(readFileSync(marker, "utf8")).toBe("who-knows-what-this-is\n");
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
    expect(await listInstalled(dir)).toHaveLength(8);
  });
});
