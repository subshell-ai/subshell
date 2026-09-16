import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHarness, listInstalled } from "@internal/pane-runtime";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import {
  installLocalPlugin,
  localPluginReports,
  localPluginsDir,
  prepareLocalPlugins,
  uninstallLocalPlugin,
} from "@/services/nodes/local-plugins.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { setupAuthTables } from "../../../api/__tests__/helpers/auth-tables.js";
import { type FakeRegistry, makePluginTgz, startFakeRegistry } from "./helpers/fake-npm-registry.js";

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
    expect(reports.map((r) => r.id).sort()).toEqual([
      "claude-code",
      "cloudflare-tunnel",
      "codex",
      "hermes",
      "netbird",
      "opencode",
      "pi",
      "tailscale",
      "terminal",
    ]);
    // Built by the same function that builds an agent's, so the shape cannot
    // drift: this is the §16 property that could not be written before.
    const one = reports.find((r) => r.id === "codex");
    expect(one?.type).toBe("agent-harness");
    expect(Array.isArray(one?.capabilities)).toBe(true);
    expect(one?.broken).toBeUndefined();
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

  it("installs and uninstalls, and the reports track the disk", async () => {
    // Since the server became the only plugin host (Task 9) there is no
    // mirror in the node row any more — the instance store IS the record,
    // read from disk by every consumer.
    await prepareLocalPlugins();
    for (const p of await listInstalled(SUBSHELL_SERVER_DATA_DIR)) await uninstallLocalPlugin(p.id);

    await installLocalPlugin("codex");
    expect((await localPluginReports()).map((r) => r.id)).toEqual(["codex"]);

    expect(await uninstallLocalPlugin("codex")).toBe(true);
    expect(await localPluginReports()).toEqual([]);
  });

  it("reports removing something already absent as a no-op, not a failure", async () => {
    await ensureLocalNode(db);
    await prepareLocalPlugins();
    await uninstallLocalPlugin("codex");

    expect(await uninstallLocalPlugin("codex")).toBe(false);
  });

  it("prepares the registry overlay at boot, so a hand-placed install RESOLVES", async () => {
    // Task 9b's boot wiring, stated as the operator-visible fact: dropping a
    // plugin directory into the store with no API call in between must still
    // make it launchable after the next start. The overlay is not seeded by
    // `listInstalled` reads or reports — only `refreshInstalledPlugins`, and
    // `prepareLocalPlugins` is the boot's caller. `afterAll`'s re-prepare is
    // what leaves this file's successor suites with a coherent overlay.
    const dir = join(localPluginsDir(), "acme-boot");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "acme-boot",
        version: "1.0.0",
        type: "module",
        subshell: {
          apiVersion: 2, // the entry below speaks v2 member names
          id: "acme-boot",
          type: "agent-harness",
          name: "Acme Boot",
          description: "hand-placed",
          entry: "index.js",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(dir, "index.js"),
      "export default () => ({ capabilities: () => [], buildCommand: (i) => [i.binary], validatePreset: () => ({ valid: true }) });\n",
      "utf8",
    );
    expect(getHarness("acme-boot")).toBeUndefined(); // unique id: nothing resolved it yet

    await prepareLocalPlugins();
    expect(getHarness("acme-boot")).toBeDefined();

    // And the uninstall side of the same wiring: the service call the routes
    // use re-syncs too, so the launch path loses it as soon as the bytes go.
    expect(await uninstallLocalPlugin("acme-boot")).toBe(true);
    expect(getHarness("acme-boot")).toBeUndefined();
  });

  /**
   * Registry installs on the control-plane host (phase 3). The registry is
   * the in-test fake; the last argument of `installLocalPlugin` is the seam
   * that points at it, and production never passes one (the configured
   * `SUBSHELL_PLUGIN_REGISTRY_URL` is the default). What is asserted here is
   * that the SAME door that writes built-ins now fetches, verifies, and
   * mirrors third-party bytes, and that a refused fetch writes nothing.
   */
  describe("installing from the registry", () => {
    const reg: FakeRegistry = startFakeRegistry();

    beforeAll(async () => {
      reg.served.set("third-party", {
        latest: "1.0.0",
        versions: { "1.0.0": makePluginTgz({ name: "third-party", version: "1.0.0", id: "third" }) },
      });
      reg.served.set("tampered", {
        latest: "1.0.0",
        tamper: true,
        versions: { "1.0.0": makePluginTgz({ name: "tampered", version: "1.0.0", id: "tampered" }) },
      });
    });

    afterAll(async () => {
      reg.stop();
      // Belt-and-braces: install writes no preset rows any more (spec
      // 2026-09-13), but a stray fixture row for one of this suite's harness
      // ids must not leak into a later suite's counts.
      await db.deleteFrom("presets").where("harnessId", "in", ["third", "tampered"]).execute();
    });

    it("installs a spec into the instance store and writes NO preset rows", async () => {
      await prepareLocalPlugins();

      await installLocalPlugin("third", "third-party@1.0.0", reg.base);

      expect((await listInstalled(SUBSHELL_SERVER_DATA_DIR)).map((p) => p.id)).toContain("third");
      expect((await localPluginReports()).map((r) => r.id)).toContain("third");
      // The Default seeding is gone (spec 2026-09-13): an install arms the
      // harness, not anyone's rows. A fresh account launches it presetless.
      expect(await db.selectFrom("presets").select("id").where("harnessId", "=", "third").execute()).toEqual([]);
    });

    it("a spec that fails integrity throws, and the store is unchanged", async () => {
      await prepareLocalPlugins();
      const before = (await localPluginReports()).map((r) => r.id).sort();

      await expect(installLocalPlugin("tampered", "tampered@1.0.0", reg.base)).rejects.toThrow(/integrity/i);

      expect((await localPluginReports()).map((r) => r.id).sort()).toEqual(before);
      expect(existsSync(join(localPluginsDir(), "tampered"))).toBe(false);
    });
  });
});
