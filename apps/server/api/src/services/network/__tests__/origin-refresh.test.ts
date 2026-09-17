import { afterEach, describe, expect, it } from "bun:test";
import type { NetworkAddress, NetworkPluginEntry, NetworkStatus } from "@internal/pane-runtime";
import {
  ORIGIN_REFRESH_MS,
  type OriginRefreshDeps,
  refreshNetworkOrigins,
  seedNetworkOrigins,
  setOriginRefreshDepsForTests,
  startOriginRefresh,
} from "@/services/network/origin-refresh.js";
import { clearNetworkState, writeNetworkState } from "@/services/network/state.js";
import { originRegistry, resetOriginRegistryForTests } from "@/services/trusted-origins.js";

/**
 * The allowlist has to be right for a non-admin who never opens the
 * Networking page, which is why boot seeds it from the records before the
 * listener, probes once after the processes are up, and then — the one timer
 * this codebase's detection allows itself — re-probes every enabled network
 * plugin on a fixed cadence. Pinned: the seed reads records only, the probe
 * skips a supervised plugin whose child is armed, and the tick is the probe.
 */
const address: NetworkAddress = {
  url: "http://100.64.0.7:3080",
  scheme: "http",
  label: "Tailscale IP",
  secureContext: false,
};

function entry(
  exposure: "private" | "public-with-gate",
  status: NetworkStatus,
  supervised = false,
): NetworkPluginEntry {
  return {
    manifest: { id: "x", network: { platforms: ["darwin", "linux"], exposure } } as NetworkPluginEntry["manifest"],
    plugin: {
      capabilities: () => [],
      status: async () => status,
      join: async () => ({ state: "joined" }),
      leave: async () => {},
      ...(supervised ? { supervisedProcess: () => ({ command: "/bin/true", args: [] }) } : {}),
    },
  };
}

function id(): string {
  return `net-refresh-${crypto.randomUUID().slice(0, 8)}`;
}

interface Rec {
  probed: string[];
  ticks: (() => void)[];
  every: number[];
}

function deps(plugins: Record<string, NetworkPluginEntry>, rec: Rec, armed: string[] = []): OriginRefreshDeps {
  return {
    listPlugins: async () => Object.keys(plugins).map((id) => ({ id })),
    getPlugin: (id) => plugins[id],
    platform: () => "darwin",
    childArmed: (id) => armed.includes(id),
    status: async (e) => {
      rec.probed.push(Object.keys(plugins).find((k) => plugins[k] === e) ?? "?");
      return e.plugin.status({ port: 3080, settings: {}, secrets: { has: () => false } });
    },
    schedule: (tick, everyMs) => {
      rec.ticks.push(tick);
      rec.every.push(everyMs);
      return { stop: () => {} };
    },
  };
}

afterEach(() => {
  setOriginRefreshDepsForTests(null);
  resetOriginRegistryForTests();
});

describe("seedNetworkOrigins", () => {
  it("trusts what the records say, probing nothing", async () => {
    const priv = id();
    const gated = id();
    const rec: Rec = { probed: [], ticks: [], every: [] };
    await writeNetworkState(priv, { published: false, port: null, addresses: [address] });
    await writeNetworkState(gated, {
      published: false,
      port: null,
      addresses: [{ ...address, url: "https://cf.example" }],
    });
    setOriginRefreshDepsForTests(
      deps(
        {
          [priv]: entry("private", { state: "joined", addresses: [], hints: [] }),
          [gated]: entry("public-with-gate", { state: "joined", addresses: [], hints: [] }),
        },
        rec,
      ),
    );
    await seedNetworkOrigins();
    expect(originRegistry().pluginOrigins(priv)).toEqual([address.url]);
    expect(originRegistry().pluginOrigins(gated)).toEqual([]);
    expect(rec.probed).toEqual([]);
    await clearNetworkState(priv);
    await clearNetworkState(gated);
  });
});

describe("refreshNetworkOrigins", () => {
  it("probes each enabled plugin once and trusts what a joined one reports", async () => {
    const plugin = id();
    const rec: Rec = { probed: [], ticks: [], every: [] };
    setOriginRefreshDepsForTests(
      deps({ [plugin]: entry("private", { state: "joined", addresses: [address], hints: [] }) }, rec),
    );
    await refreshNetworkOrigins();
    expect(rec.probed).toEqual([plugin]);
    expect(originRegistry().has(address.url)).toBe(true);
    await clearNetworkState(plugin);
  });

  it("skips a supervised plugin whose child is armed, like the boot health read does", async () => {
    const plugin = id();
    const rec: Rec = { probed: [], ticks: [], every: [] };
    setOriginRefreshDepsForTests(
      deps({ [plugin]: entry("public-with-gate", { state: "joined", addresses: [address], hints: [] }, true) }, rec, [
        plugin,
      ]),
    );
    await refreshNetworkOrigins();
    expect(rec.probed).toEqual([]);
  });

  it("a plugin that throws costs only its own row", async () => {
    const bad = id();
    const good = id();
    const rec: Rec = { probed: [], ticks: [], every: [] };
    const throwing = entry("private", { state: "joined", addresses: [], hints: [] });
    throwing.plugin.status = async () => {
      throw new Error("vendor cli exploded");
    };
    setOriginRefreshDepsForTests(
      deps({ [bad]: throwing, [good]: entry("private", { state: "joined", addresses: [address], hints: [] }) }, rec),
    );
    await refreshNetworkOrigins();
    expect(originRegistry().has(address.url)).toBe(true);
    await clearNetworkState(good);
  });
});

describe("startOriginRefresh", () => {
  it("schedules the probe every ORIGIN_REFRESH_MS, and each tick is a refresh", async () => {
    const plugin = id();
    const rec: Rec = { probed: [], ticks: [], every: [] };
    setOriginRefreshDepsForTests(
      deps({ [plugin]: entry("private", { state: "joined", addresses: [address], hints: [] }) }, rec),
    );
    startOriginRefresh();
    expect(rec.every).toEqual([ORIGIN_REFRESH_MS]);
    expect(ORIGIN_REFRESH_MS).toBe(5 * 60 * 1000);
    rec.ticks[0]?.();
    await new Promise((r) => setTimeout(r, 10)); // the tick is fire-and-forget
    expect(rec.probed).toEqual([plugin]);
    await clearNetworkState(plugin);
  });
});
