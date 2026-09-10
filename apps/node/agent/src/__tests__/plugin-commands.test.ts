import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEmbedded, listInstalled } from "@internal/pane-runtime";
import type { NodeEvent } from "@internal/subshell-protocol";
import { execPluginInstall, execPluginUninstall } from "../commands/basics.js";
import type { CommandContext } from "../commands/context.js";
import { buildInventoryEvent, resetInventoryScanCache } from "../inventory.js";

/**
 * The two plugin commands.
 *
 * Both answer with the node's WHOLE set rather than the one plugin, because
 * the control plane mirrors what the node reports: a partial answer would
 * leave it guessing at the rest.
 */
/** A context whose socket keeps what was sent, so the pushes are observable. */
function ctxFor(dataDir: string): CommandContext & { sent: NodeEvent[] } {
  const sent: NodeEvent[] = [];
  return {
    sent,
    config: { serverUrl: "", nodeId: "n", nodeKey: "k", controlPublicKey: "{}", dataDir, name: "n" },
    nowMs: () => Date.now(),
    ws: {
      send(event: NodeEvent) {
        sent.push(event);
      },
    },
  } as unknown as CommandContext & { sent: NodeEvent[] };
}

/** The inventory events a context received, in order. */
function inventories(ctx: { sent: NodeEvent[] }): Extract<NodeEvent, { type: "inventory" }>[] {
  return ctx.sent.filter((e): e is Extract<NodeEvent, { type: "inventory" }> => e.type === "inventory");
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

describe("the inventory a plugin change pushes", () => {
  it("goes out on install, carrying the plugin that was just added", async () => {
    // The probe follows what is INSTALLED, so without this push the new
    // plugin has no row until the next cadence tick and the node page reads
    // "program not found" on a machine where the program is on the PATH.
    resetInventoryScanCache();
    const dir = tempDataDir();
    const ctx = ctxFor(dir);
    await execPluginInstall(ctx, { type: "plugin_install", id: "codex" });

    const events = inventories(ctx);
    expect(events.length).toBe(1);
    expect(events[0]?.harnesses.map((h) => h.harnessId)).toEqual(["codex"]);
    expect(events[0]?.plugins?.map((p) => p.id)).toEqual(["codex"]);
  });

  it("goes out on uninstall, no longer carrying what was removed", async () => {
    resetInventoryScanCache();
    const dir = tempDataDir();
    const ctx = ctxFor(dir);
    await execPluginInstall(ctx, { type: "plugin_install", id: "codex" });
    await execPluginUninstall(ctx, { type: "plugin_uninstall", id: "codex" });

    const events = inventories(ctx);
    expect(events.length).toBe(2);
    expect(events[1]?.harnesses).toEqual([]);
  });

  it("drops the scan memo, so the push is not the probe from before the change", async () => {
    // The memo coalesces the inventories that land together on a connection.
    // Reusing one across an install is precisely the staleness it must not
    // introduce: two installs a moment apart must report different sets.
    resetInventoryScanCache();
    const dir = tempDataDir();
    const ctx = ctxFor(dir);
    await execPluginInstall(ctx, { type: "plugin_install", id: "codex" });
    await execPluginInstall(ctx, { type: "plugin_install", id: "pi" });

    const events = inventories(ctx);
    expect(events[0]?.harnesses.map((h) => h.harnessId)).toEqual(["codex"]);
    expect(events[1]?.harnesses.map((h) => h.harnessId)).toEqual(["codex", "pi"]);
  });
});

describe("an inventory built with no data dir", () => {
  it("does not poison the memo for the callers that have one", async () => {
    // It answers empty because there is nothing to probe, which is fine. What
    // is not fine is caching that empty answer under the key a real probe
    // shares: one such call used to blank the inventory for ten seconds.
    resetInventoryScanCache();
    const dir = tempDataDir();
    await installEmbedded(dir, "codex");

    await buildInventoryEvent(Date.now());
    const real = await buildInventoryEvent(Date.now(), undefined, dir);
    expect(real.harnesses.map((h) => h.harnessId)).toEqual(["codex"]);
  });
});
