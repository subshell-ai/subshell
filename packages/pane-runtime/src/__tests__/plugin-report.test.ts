import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@subshell-ai/plugin-api";
import { buildPluginReports, bundledPluginVersion, installEmbedded, pluginsDir } from "../index.js";

/**
 * What a host learns about its own installed plugins, as wire data.
 *
 * `buildPluginReports` lives here and the control plane consumes it for
 * `local`'s declaration mirror (`apps/server/api/src/modules/nodes/
 * local-plugins.ts`); the agent stopped calling it when the node lost its
 * plugin concept (inversion spec §6), so these pins moved with the only
 * remaining consumer rather than being deleted with the agent-side copy.
 * They pin that the data is actually there, because a missing field surfaces
 * as an empty preset editor rather than as an error.
 */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "plugin-report-"));
}

/**
 * Write one plugin package the way an install leaves it, for the copies the
 * embedded installer cannot produce: one older than the bundle, a newer one, a
 * registry sidecar, a copy built against a future plugin-api.
 *
 * `version` and `apiVersion` go into package.json, `record` writes the
 * `install.json` sidecar a registry install leaves, and `body` replaces the
 * entry module — which is how a test proves whether a copy was imported at all.
 */
async function writePlugin(
  dataDir: string,
  id: string,
  opts: { version?: string; apiVersion?: number; body?: string; record?: { name: string; version: string } } = {},
): Promise<string> {
  const dir = join(pluginsDir(dataDir), id);
  mkdirSync(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: id,
      version: opts.version ?? "1.0.0",
      type: "module",
      subshell: {
        apiVersion: opts.apiVersion ?? PLUGIN_API_VERSION,
        id,
        type: "agent-harness",
        name: `${id} plugin`,
        description: "a scripted install",
        entry: "index.js",
      },
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "index.js"),
    opts.body ??
      "export default () => ({\n" +
        "  capabilities: () => [],\n" +
        "  buildCommand: (input) => [input.binary],\n" +
        "  validatePreset: () => ({ valid: true }),\n" +
        "});\n",
    "utf8",
  );
  if (opts.record) {
    await writeFile(
      join(dir, "install.json"),
      JSON.stringify({ integrity: "sha512-test", installedAt: "2026-01-01T00:00:00.000Z", ...opts.record }),
      "utf8",
    );
  }
  return dir;
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
    expect(report?.capabilities.sort()).toEqual(["attention", "mcp", "resume", "settings", "subagents"]);
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
    // (`apps/server/api/src/modules/subshells/mcp-resolve.ts`) pins
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

  it("renders manual hook lines against the PORTABLE reporter — the server's own spelling", async () => {
    // Same cross-package rule as the mcp literal above: `plugin-report.ts`
    // spells { command: "subshell", args: ["report"] } for the Nodes page and
    // `apps/server/api/src/modules/subshells/mcp-resolve.ts` pins PORTABLE_REPORTER
    // for the preset editor. Both sides hold the literal; drift would show
    // users two different hook commands for one harness.
    const dir = tempDataDir();
    await installEmbedded(dir, "hermes");
    const [report] = await buildPluginReports(dir);
    const mcp = report?.mcpSetup as { mode: string; steps: { command: string }[] };
    expect(mcp.mode).toBe("manual");
    const hooksStep = mcp.steps.find((step) => step.command.includes("subagent_start"));
    expect(hooksStep?.command).toContain("'subshell' 'report' 'subagents'");
  });

  it("reports a plugin that fails to load, carrying its error", async () => {
    // Dropping the row would make a broken plugin look uninstalled, and the
    // node page could not explain the difference. A THIRD-PARTY copy is the
    // case that reports `broken`: nothing in this build can stand in for it,
    // so the failure IS the row.
    const dir = tempDataDir();
    await writePlugin(dir, "third-party", { body: "throw new Error('boom at import');" });
    const [report] = await buildPluginReports(dir);
    expect(report?.id).toBe("third-party");
    expect(report?.source).toBe("unrecorded");
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

  it("describes the bundled copy when the installed one is older, and never imports it", async () => {
    const dir = tempDataDir();
    const marker = join(dir, "imported");
    await writePlugin(dir, "pi", {
      version: "0.0.1",
      body: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); export default () => ({ capabilities: () => [], buildCommand: (i) => [i.binary], validatePreset: () => ({ valid: true }) });`,
    });
    const [pi] = await buildPluginReports(dir);
    expect(pi?.version).toBe((await bundledPluginVersion("pi")) ?? "");
    // The name comes from the COMPILED copy ("pi"), not from the disk
    // manifest ("pi plugin"): the row describes the copy that answers.
    expect(pi?.name).toBe("pi");
    expect(pi?.source).toBe("build");
    expect(pi?.shadowed).toEqual({ version: "0.0.1", source: "build" });
    // The loser is decided by version and manifest alone: importing it runs
    // code that lost, and the module cache would keep it for the process's
    // life.
    expect(existsSync(marker)).toBe(false);
  });

  it("names an npm copy that is present but not in use", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "pi", { version: "0.0.1", record: { name: "@subshell-ai/plugin-pi", version: "0.0.1" } });
    const [pi] = await buildPluginReports(dir);
    expect(pi?.source).toBe("build");
    expect(pi?.shadowed).toMatchObject({ version: "0.0.1", source: "npm" });
  });

  it("falls back to the bundle when the newer installed copy needs a newer host", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "pi", { version: "99.0.0", apiVersion: 99 });
    const [pi] = await buildPluginReports(dir);
    expect(pi?.version).toBe((await bundledPluginVersion("pi")) ?? "");
    expect(pi?.broken).toBeUndefined();
    expect(pi?.shadowed?.error).toContain("plugin-api");
  });

  it("describes a newer installed copy that loads", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "pi", { version: "99.0.0" });
    const [pi] = await buildPluginReports(dir);
    expect(pi?.version).toBe("99.0.0");
    // The disk copy's own manifest answers here: this one won.
    expect(pi?.name).toBe("pi plugin");
    expect(pi?.source).toBe("build");
    expect(pi?.shadowed).toBeUndefined();
  });

  it("flags a stale installed winner: new bytes on disk, old code in the module cache", async () => {
    // The update case the restart offer exists for. The ESM cache cannot be
    // evicted, so once this process imported the installed copy, replacing its
    // entry leaves the OLD factory answering under the NEW version — and a row
    // that reported the new version without this flag would say the update had
    // taken effect when it had not.
    const dir = tempDataDir();
    const body = (marker: string) =>
      "export default () => ({\n" +
      "  capabilities: () => [],\n" +
      `  buildCommand: (input) => [input.binary, ${JSON.stringify(marker)}],\n` +
      "  validatePreset: () => ({ valid: true }),\n" +
      "});\n";
    await writePlugin(dir, "pi", { version: "99.0.0", body: body("--first") });
    const [before] = await buildPluginReports(dir);
    // The installed copy won, and nothing has changed under it yet.
    expect(before?.version).toBe("99.0.0");
    expect(before?.restartRequired).toBeUndefined();

    await writePlugin(dir, "pi", { version: "99.0.0", body: body("--second") });
    const [after] = await buildPluginReports(dir);
    // Same version, new bytes: the copy on disk is newer than the running code.
    expect(after?.version).toBe("99.0.0");
    expect(after?.restartRequired).toBe(true);
  });

  it("reports a newer copy that fails to load as a shadow, not a broken row", async () => {
    // The bundle answers, because a copy that will not load has not won. The
    // failure still reaches the page, on `shadowed`, or an operator who just
    // upgraded into a broken copy would see a healthy row.
    const dir = tempDataDir();
    await writePlugin(dir, "pi", { version: "99.0.0", body: "throw new Error('boom at import');" });
    const [report] = await buildPluginReports(dir);
    expect(report?.version).toBe((await bundledPluginVersion("pi")) ?? "");
    expect(report?.broken).toBeUndefined();
    expect(report?.shadowed?.error).toContain("boom at import");
  });

  it("omits a shadow when the installed copy is the bundle's own", async () => {
    // The seeded state every boot produces: same version, same bytes. Naming
    // it as shadowed would make every healthy row look like a conflict.
    const dir = tempDataDir();
    await installEmbedded(dir, "pi");
    const [pi] = await buildPluginReports(dir);
    expect(pi?.source).toBe("build");
    expect(pi?.shadowed).toBeUndefined();
  });

  it("names a third-party registry copy as npm", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "third-party", {
      version: "1.2.3",
      record: { name: "@acme/plugin-third-party", version: "1.2.3" },
    });
    const [report] = await buildPluginReports(dir);
    expect(report?.source).toBe("npm");
  });

  it("names a third-party copy with no sidecar as unrecorded", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "third-party");
    const [report] = await buildPluginReports(dir);
    expect(report?.source).toBe("unrecorded");
  });
});
