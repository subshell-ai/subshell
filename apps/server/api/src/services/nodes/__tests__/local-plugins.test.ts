import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { listInstalled } from "@internal/pane-runtime";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import {
  installLocalPlugin,
  localPluginReports,
  localPluginsDir,
  prepareLocalPlugins,
  uninstallLocalPlugin,
} from "@/services/nodes/local-plugins.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { setupAuthTables } from "../../../api/__tests__/helpers/auth-tables.js";

/**
 * The control-plane host's own plugins directory (spec 2026-09-09 §11).
 *
 * `local` is a node like any other now, so what is asserted here is mostly
 * SAMENESS: the same directory layout, the same seeding rule, the same report
 * shape an agent sends. Under `SUBSHELL_TEST_MODE` the data dir is a
 * per-process temp path, so this writes nowhere near a real install.
 */
describe("the control-plane host's plugins", () => {
  beforeAll(async () => {
    // The app + auth migrations; `ensureLocalNode` needs the `nodes` table and
    // the system user that owns the row.
    await setupAuthTables();
  });

  beforeEach(() => {
    rmSync(localPluginsDir(), { recursive: true, force: true });
  });

  afterAll(async () => {
    // Put the host back. Bun shares one process, and therefore one data dir,
    // across test FILES: the last case here leaves the directory emptied, and
    // the completion marker means a later suite's `seedLocalPluginsForTests`
    // short-circuits rather than restoring it. Every suite after this one
    // would then see a host that offers nothing, ordered by filename.
    rmSync(localPluginsDir(), { recursive: true, force: true });
    await prepareLocalPlugins();
  });

  it("seeds the built-ins on first run and reports them in an agent's shape", async () => {
    await prepareLocalPlugins();

    const reports = await localPluginReports();
    expect(reports.map((r) => r.id).sort()).toEqual(["claude-code", "codex", "hermes", "opencode", "pi"]);
    // Built by the same function that builds an agent's, so the shape cannot
    // drift: this is the §16 property that could not be written before.
    const one = reports.find((r) => r.id === "codex");
    expect(one?.type).toBe("agent-harness");
    expect(Array.isArray(one?.capabilities)).toBe(true);
    expect(one?.broken).toBeUndefined();
  });

  it("mirrors the report into its own node row, in the column an agent's lands in", async () => {
    await ensureLocalNode(db);
    await prepareLocalPlugins();

    const row = await new NodesRepository(db).findById(LOCAL_NODE_ID);
    const mirrored = JSON.parse(String(row?.pluginsJson ?? "[]")) as { id: string }[];
    expect(mirrored.map((p) => p.id).sort()).toEqual(["claude-code", "codex", "hermes", "opencode", "pi"]);
  });

  it("does not re-seed a host whose plugins the operator removed", async () => {
    // "Offers nothing" has to be reachable here too. Re-seeding on every boot
    // would make an uninstall on this host undo itself, which is the one rule
    // the whole seeding design exists to protect.
    await ensureLocalNode(db);
    await prepareLocalPlugins();
    for (const p of await listInstalled(SUBSHELL_SERVER_DATA_DIR)) await uninstallLocalPlugin(p.id);

    await prepareLocalPlugins();

    expect(await localPluginReports()).toEqual([]);
  });

  it("installs and uninstalls, refreshing the mirror each time", async () => {
    await ensureLocalNode(db);
    await prepareLocalPlugins();
    for (const p of await listInstalled(SUBSHELL_SERVER_DATA_DIR)) await uninstallLocalPlugin(p.id);

    await installLocalPlugin("codex");
    const nodes = new NodesRepository(db);
    let mirrored = JSON.parse(String((await nodes.findById(LOCAL_NODE_ID))?.pluginsJson ?? "[]")) as { id: string }[];
    expect(mirrored.map((p) => p.id)).toEqual(["codex"]);

    expect(await uninstallLocalPlugin("codex")).toBe(true);
    mirrored = JSON.parse(String((await nodes.findById(LOCAL_NODE_ID))?.pluginsJson ?? "[]")) as { id: string }[];
    expect(mirrored).toEqual([]);
  });

  it("reports removing something already absent as a no-op, not a failure", async () => {
    await ensureLocalNode(db);
    await prepareLocalPlugins();
    await uninstallLocalPlugin("codex");

    expect(await uninstallLocalPlugin("codex")).toBe(false);
  });
});
