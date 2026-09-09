import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPluginInstall, execPluginUninstall } from "../commands/basics.js";
import type { CommandContext } from "../commands/context.js";
import { listInstalled } from "../plugins-dir.js";

/**
 * The two v6 plugin commands.
 *
 * Both answer with the node's WHOLE set rather than the one plugin, because
 * the control plane mirrors what the node reports: a partial answer would
 * leave it guessing at the rest.
 */
function ctxFor(dataDir: string): CommandContext {
  return {
    config: { serverUrl: "", nodeId: "n", nodeKey: "k", controlPublicKey: "{}", dataDir, name: "n" },
  } as unknown as CommandContext;
}

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugin-cmd-"));
}

describe("plugin_install", () => {
  it("installs and answers with the whole set", async () => {
    const dir = tempDataDir();
    const result = await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "codex" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plugins = (result.data as { plugins: { id: string }[] }).plugins;
    expect(plugins.map((p) => p.id)).toEqual(["codex"]);
  });

  it("answers ok:false naming an unknown plugin", async () => {
    const result = await execPluginInstall(ctxFor(tempDataDir()), { type: "plugin_install", id: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("nope");
  });

  it("refuses an unsafe id before it reaches the filesystem", async () => {
    const result = await execPluginInstall(ctxFor(tempDataDir()), { type: "plugin_install", id: "../escape" });
    expect(result.ok).toBe(false);
  });
});

describe("plugin_uninstall", () => {
  it("removes it and answers with what remains", async () => {
    const dir = tempDataDir();
    await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "pi" });
    await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "codex" });
    const result = await execPluginUninstall(ctxFor(dir), { type: "plugin_uninstall", id: "pi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { removed: boolean; plugins: { id: string }[] };
    expect(data.removed).toBe(true);
    expect(data.plugins.map((p) => p.id)).toEqual(["codex"]);
  });

  it("SUCCEEDS when the plugin was already absent", async () => {
    // The caller asked for a state and that state holds. Failing here would
    // make a retry after a dropped connection look like a real failure.
    const result = await execPluginUninstall(ctxFor(tempDataDir()), { type: "plugin_uninstall", id: "pi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { removed: boolean }).removed).toBe(false);
  });

  it("leaves the node's other plugins alone", async () => {
    const dir = tempDataDir();
    await execPluginInstall(ctxFor(dir), { type: "plugin_install", id: "hermes" });
    await execPluginUninstall(ctxFor(dir), { type: "plugin_uninstall", id: "codex" });
    expect((await listInstalled(dir)).map((p) => p.id)).toEqual(["hermes"]);
  });
});
