import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginReports, installEmbedded, pluginsDir } from "@internal/pane-runtime";

/**
 * What the control plane learns about a node's plugins.
 *
 * The server holds no plugin code for a machine it does not run on, so
 * everything it needs to render and validate one travels as data. These pin
 * that the data is actually there, because a missing field surfaces as an
 * empty profile editor rather than as an error.
 */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugin-report-"));
}

describe("buildPluginReports", () => {
  it("reports nothing for a node with nothing installed", async () => {
    expect(await buildPluginReports(tempDataDir())).toEqual([]);
  });

  it("reports what the profile editor and the launch gate need", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "claude-code");
    const [report] = await buildPluginReports(dir);

    expect(report?.id).toBe("claude-code");
    expect(report?.name).toBe("Claude Code");
    expect(report?.type).toBe("agent-harness");
    expect(report?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report?.capabilities.sort()).toEqual(["attention", "mcp", "resume", "settings"]);
    // Non-empty, because an empty settings list renders as a profile editor
    // with nothing in it and looks like a working screen.
    expect((report?.profileSettings ?? []).length).toBeGreaterThan(0);
    expect((report?.suggestedFlags ?? []).length).toBeGreaterThan(0);
    expect(report?.mcpSetup).toBeTruthy();
    expect(report?.exitStatuses).toBeTruthy();
    expect(report?.broken).toBeUndefined();
  });

  it("reports a plugin that fails to load, carrying its error", async () => {
    // Dropping the row would make a broken plugin look uninstalled, and the
    // node page could not explain the difference.
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    await writeFile(join(pluginsDir(dir), "pi", "dist", "index.js"), "throw new Error('boom at import');", "utf8");
    const [report] = await buildPluginReports(dir);
    expect(report?.id).toBe("pi");
    expect(report?.broken).toContain("boom at import");
  });

  it("reports a plugin whose manifest will not parse", async () => {
    const dir = tempDataDir();
    mkdirSync(join(pluginsDir(dir), "junk"), { recursive: true });
    await writeFile(join(pluginsDir(dir), "junk", "package.json"), "{not json", "utf8");
    const [report] = await buildPluginReports(dir);
    expect(report?.id).toBe("junk");
    expect(report?.broken).toBeTruthy();
  });

  it("reports several in a stable order", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    await installEmbedded(dir, "codex");
    expect((await buildPluginReports(dir)).map((r) => r.id)).toEqual(["codex", "pi"]);
  });
});
