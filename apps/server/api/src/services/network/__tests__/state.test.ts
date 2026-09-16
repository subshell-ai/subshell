import { describe, expect, it } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPluginSecrets, type NetworkPluginEntry, pluginStateDir } from "@internal/pane-runtime";
import { SERVER_PORT, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { clearNetworkState, networkContext, readNetworkState, writeNetworkState } from "@/services/network/state.js";

/**
 * State is a file under the TEST data dir, which `constants.ts` forces to a
 * fresh temp directory — so these run against real filesystem semantics
 * (modes, atomic rename, a corrupt file) without a fixture directory of their
 * own. Ids are unique per test because `bun test` shares one process.
 */
function id(): string {
  return `net-state-${crypto.randomUUID().slice(0, 8)}`;
}

/** A plugin entry carrying only what `networkContext` reads: its settings fields. */
function entryWithSecrets(...keys: string[]): NetworkPluginEntry {
  return {
    manifest: {} as NetworkPluginEntry["manifest"],
    plugin: {
      capabilities: () => [],
      status: async () => ({ state: "joined", addresses: [], hints: [] }),
      join: async () => ({ state: "joined" }),
      leave: async () => {},
      settingsFields: () => [
        { key: "hostname", label: "Hostname", type: "string" },
        ...keys.map((key) => ({ key, label: key, type: "secret" as const })),
      ],
    },
  };
}

describe("network state", () => {
  it("answers with defaults for a plugin nothing was ever recorded for", async () => {
    expect(await readNetworkState(id())).toEqual({ settings: {}, published: false, port: null, addresses: [] });
  });

  it("round-trips a publish and merges later patches field by field", async () => {
    const plugin = id();
    await writeNetworkState(plugin, { settings: { hostname: "box" }, published: true, port: 3080 });
    await writeNetworkState(plugin, {
      addresses: [{ url: "https://box.tail.ts.net", scheme: "https", label: "MagicDNS", secureContext: true }],
    });

    const state = await readNetworkState(plugin);
    // The settings and the port survived a patch that named neither: a write
    // that reset unnamed fields would silently unpublish on a settings save.
    expect(state.settings).toEqual({ hostname: "box" });
    expect(state.published).toBe(true);
    expect(state.port).toBe(3080);
    expect(state.addresses).toHaveLength(1);
  });

  it("writes 0600 inside a 0700 directory", async () => {
    const plugin = id();
    await writeNetworkState(plugin, { published: true });
    const dir = pluginStateDir(SUBSHELL_SERVER_DATA_DIR, plugin);
    expect((await stat(join(dir, "network.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("reads a corrupt or hand-edited file as 'nothing is published' rather than throwing", async () => {
    const plugin = id();
    const dir = pluginStateDir(SUBSHELL_SERVER_DATA_DIR, plugin);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "network.json"), "{ this is not json");
    // Boot reads this. A throw here would be a network plugin deciding whether
    // the server comes up.
    expect(await readNetworkState(plugin)).toEqual({ settings: {}, published: false, port: null, addresses: [] });

    await writeFile(join(dir, "network.json"), JSON.stringify({ published: true, addresses: "not an array" }));
    const state = await readNetworkState(plugin);
    expect(state.published).toBe(true);
    // Field-by-field, so code typed to receive an array never gets a string.
    expect(state.addresses).toEqual([]);
  });

  it("serializes concurrent writes instead of losing one", async () => {
    const plugin = id();
    await Promise.all([
      writeNetworkState(plugin, { published: true }),
      writeNetworkState(plugin, { port: 4000 }),
      writeNetworkState(plugin, { settings: { a: "b" } }),
    ]);
    const state = await readNetworkState(plugin);
    // Every read-merge-write saw the previous one; unserialized, the last
    // writer's read would have predated the other two.
    expect(state).toMatchObject({ published: true, port: 4000, settings: { a: "b" } });
  });

  it("clears everything it recorded", async () => {
    const plugin = id();
    await writeNetworkState(plugin, { published: true, port: 3080 });
    await clearNetworkState(plugin);
    expect(await readNetworkState(plugin)).toEqual({ settings: {}, published: false, port: null, addresses: [] });
  });

  describe("networkContext", () => {
    it("reports the RUNNING port and the stored settings", async () => {
      const plugin = id();
      await writeNetworkState(plugin, { settings: { hostname: "box" }, port: 9999, published: true });
      const ctx = await networkContext(plugin, entryWithSecrets());
      // Never the recorded port: the difference between the two is exactly
      // what boot reconciles, and a plugin told the old one could not notice.
      expect(ctx.port).toBe(SERVER_PORT);
      expect(ctx.settings).toEqual({ hostname: "box" });
    });

    it("reports only the declared secrets that are actually set", async () => {
      const plugin = id();
      const secrets = createPluginSecrets(SUBSHELL_SERVER_DATA_DIR, plugin);
      await secrets.set("authkey", "tskey-abc");
      await secrets.set("undeclared", "whatever");

      const ctx = await networkContext(plugin, entryWithSecrets("authkey", "apitoken"));
      expect(ctx.secrets.has("authkey")).toBe(true);
      expect(ctx.secrets.has("apitoken")).toBe(false);
      // Set on disk but never declared as a field: a plugin cannot learn about
      // a secret it did not ask the host to hold for it.
      expect(ctx.secrets.has("undeclared")).toBe(false);
    });

    it("is synchronous and stable, so two asks inside one status() agree", async () => {
      const plugin = id();
      const ctx = await networkContext(plugin, entryWithSecrets("authkey"));
      expect(ctx.secrets.has("authkey")).toBe(false);
      // Written AFTER the context was built: the snapshot is the point — a
      // per-call stat would let a rotation land between two asks in one call.
      await createPluginSecrets(SUBSHELL_SERVER_DATA_DIR, plugin).set("authkey", "later");
      expect(ctx.secrets.has("authkey")).toBe(false);
    });
  });
});
