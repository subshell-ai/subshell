import { describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installEmbedded,
  listInstalled,
  pluginsDir,
  recoverInterruptedInstalls,
  refreshStaleBuiltIns,
  uninstallPlugin,
} from "../plugins-dir.js";

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
    // Must stay strictly older than the embedded copy, or there is nothing
    // stale to refresh. The bootstrap pinned every package to 0.0.1, so the
    // downgrade sentinel is 0.0.0 and only ever gets further behind.
    pkg.version = "0.0.0";
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

describe("an install interrupted mid-swap", () => {
  /** Exactly what a kill between the two renames leaves on disk. */
  async function interruptMidSwap(dataDir: string, id: string): Promise<void> {
    const root = pluginsDir(dataDir);
    renameSync(join(root, id), join(root, `.old-${id}-${crypto.randomUUID()}`));
  }

  it("keeps the working directories out of the listing", async () => {
    // These used to read as plugins with no package.json: a broken row that
    // no uninstall could remove, since uninstall refuses the same names.
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    mkdirSync(join(pluginsDir(dir), ".tmp-codex-abc"), { recursive: true });
    mkdirSync(join(pluginsDir(dir), ".old-codex-def"), { recursive: true });

    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["codex"]);
  });

  it("puts the plugin back at the next boot, rather than losing it", async () => {
    // The old order was rm-then-rename, so a kill during the recursive delete
    // UNINSTALLED the plugin being upgraded, with no copy left anywhere.
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    await interruptMidSwap(dir, "codex");
    expect(await listInstalled(dir)).toEqual([]);

    expect(await recoverInterruptedInstalls(dir)).toEqual({ recovered: ["codex"], removed: 0 });
    const back = await listInstalled(dir);
    expect(back.map((p) => p.id)).toEqual(["codex"]);
    expect(back[0]?.broken).toBeUndefined();
  });

  it("discards the displaced copy when the swap did complete", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    const root = pluginsDir(dir);
    cpSync(join(root, "codex"), join(root, `.old-codex-${crypto.randomUUID()}`), { recursive: true });

    expect(await recoverInterruptedInstalls(dir)).toEqual({ recovered: [], removed: 1 });
    expect(readdirSync(root)).toEqual(["codex"]);
  });

  it("removes a staging directory and a copy that declares nothing", async () => {
    // A `.tmp-` is never promotable, and an `.old-` with no readable manifest
    // names no id to restore it as.
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    mkdirSync(join(pluginsDir(dir), ".tmp-codex-abc"), { recursive: true });
    mkdirSync(join(pluginsDir(dir), ".old-junk-def"), { recursive: true });

    expect(await recoverInterruptedInstalls(dir)).toEqual({ recovered: [], removed: 2 });
    expect(readdirSync(pluginsDir(dir))).toEqual(["codex"]);
  });

  it("recovering a data dir with no plugins directory is a no-op", async () => {
    expect(await recoverInterruptedInstalls(tempDataDir())).toEqual({ recovered: [], removed: 0 });
  });
});

describe("upgrading a plugin in place", () => {
  it("removes the copy it set aside, so upgrades do not accumulate", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    await installEmbedded(dir, "codex");
    expect(readdirSync(pluginsDir(dir))).toEqual(["codex"]);
  });
});

describe("a refresh pass with an unreadable plugin in it", () => {
  it("carries on past one that this build cannot replace", async () => {
    // `aaa` sorts first and is nobody's built-in, so the pass skips it before
    // reading any version at all. What must not happen is that ending the
    // pass: `codex` sorts after it and IS repairable.
    //
    // This does NOT cover a built-in whose own package.json is malformed.
    // That throw lives in `readBuiltIn`, and its test is in
    // `packages/pane-runtime/src/__tests__/embedded-plugins.test.ts` because
    // reaching it needs a fixture in the checkout, not in a data dir.
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");
    await writeFile(join(pluginsDir(dir), "codex", "package.json"), "{ not json");
    mkdirSync(join(pluginsDir(dir), "aaa"), { recursive: true });
    await writeFile(join(pluginsDir(dir), "aaa", "package.json"), "{ also not json");

    expect(await refreshStaleBuiltIns(dir)).toEqual(["codex"]);
    const after = await listInstalled(dir);
    expect(after.map((p) => p.id)).toEqual(["aaa", "codex"]);
    // Repaired from this build's bytes; the stranger is left exactly as found.
    expect(after.find((p) => p.id === "codex")?.broken).toBeUndefined();
    expect(after.find((p) => p.id === "aaa")?.broken).toBeTruthy();
  });
});
