import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginReports, installEmbedded, pluginsDir } from "../index.js";

/**
 * What a host learns about its own installed plugins, as wire data.
 *
 * `buildPluginReports` lives here and the control plane consumes it for
 * `local`'s declaration mirror (`apps/server/api/src/services/nodes/
 * local-plugins.ts`); the agent stopped calling it when the node lost its
 * plugin concept (inversion spec §6), so these pins moved with the only
 * remaining consumer rather than being deleted with the agent-side copy.
 * They pin that the data is actually there, because a missing field surfaces
 * as an empty preset editor rather than as an error.
 */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugin-report-"));
}

describe("buildPluginReports", () => {
  it("reports nothing for a node with nothing installed", async () => {
    expect(await buildPluginReports(tempDataDir())).toEqual([]);
  });

  it("reports what the preset editor and the launch gate need", async () => {
    const dir = tempDataDir();
    await installEmbedded(dir, "claude-code");
    const [report] = await buildPluginReports(dir);

    expect(report?.id).toBe("claude-code");
    expect(report?.name).toBe("Claude Code");
    expect(report?.type).toBe("agent-harness");
    expect(report?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report?.capabilities.sort()).toEqual(["attention", "mcp", "resume", "settings"]);
    // Non-empty, because an empty settings list renders as a preset editor
    // with nothing in it and looks like a working screen.
    expect((report?.presetSettings ?? []).length).toBeGreaterThan(0);
    expect((report?.suggestedFlags ?? []).length).toBeGreaterThan(0);
    expect(report?.mcpSetup).toBeTruthy();
    expect(report?.exitStatuses).toBeTruthy();
    expect(report?.broken).toBeUndefined();
  });

  it("renders manual harness steps against the PORTABLE launch — the preset editor's own spelling", async () => {
    // Cross-package contract, reviewed after #57: `PORTABLE_MCP_LAUNCH`
    // (`apps/server/api/src/services/mcp-resolve.ts`) pins
    // { command: "subshell", args: ["mcp"] } for the schema route, and THIS
    // package spells the same literal at `plugin-report.ts`. It cannot import
    // the constant — pane-runtime is Apache, the constant is a VALUE export
    // from AGPL `apps/server/`, and the section-7 carve-out is type-only —
    // so both sides pin the literal and drift fails a test here or there.
    // Drift otherwise means the Nodes page and the preset editor show users
    // different manual-registration commands: the exact disagreement class
    // #57 closed.
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    const [report] = await buildPluginReports(dir);
    const mcp = report?.mcpSetup as { mode: string; steps: { command: string }[] };
    expect(mcp.mode).toBe("manual");
    expect(JSON.parse(mcp.steps[1].command).mcpServers.subshell).toEqual({ command: "subshell", args: ["mcp"] });
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
