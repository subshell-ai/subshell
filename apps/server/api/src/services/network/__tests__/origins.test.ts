import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import type { NetworkAddress, NetworkStatus } from "@internal/pane-runtime";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import {
  forgetNetworkOrigins,
  observeNetworkStatus,
  originsOf,
  setNetworkOriginsResolveForTests,
  syncNetworkOrigins,
} from "@/services/network/origins.js";
import { clearNetworkState, networkStatePath, readNetworkState, writeNetworkState } from "@/services/network/state.js";
import { originRegistry, resetOriginRegistryForTests } from "@/services/trusted-origins.js";

/**
 * The trust-scope rule (spec § 10f): a PRIVATE network's addresses are
 * trusted whenever this host is on it — joined is enough, because a tailnet
 * IP answers with no `serve` at all — while a PUBLIC-WITH-GATE network's
 * addresses count only from a record that says published, because the Access
 * guard is armed before a publish completes and never before.
 */
const magic: NetworkAddress = { url: "https://box.ts.net", scheme: "https", label: "MagicDNS", secureContext: true };
const ip: NetworkAddress = {
  url: "http://100.64.0.7:3080",
  scheme: "http",
  label: "Tailscale IP",
  secureContext: false,
};

function status(state: NetworkStatus["state"], addresses: NetworkAddress[] = [magic, ip]): NetworkStatus {
  return { state, addresses, hints: [] };
}

/** A fresh plugin id per case: `bun test` shares one process and one data dir. */
function id(): string {
  return `net-origins-${crypto.randomUUID().slice(0, 8)}`;
}

beforeAll(async () => {
  // The enabled-guard cases below write real `plugin_state` rows; the file
  // used to be fs-and-registry only. Applied by the test, never assumed.
  await runMigrations();
});

beforeEach(() => {
  // The real registry holds only built-ins, and every id here is synthetic,
  // so the loadability guard would (correctly) refuse them all. The suites'
  // fakes never reach the real pane-runtime registry — this is the seam the
  // guard's doc names. The uninstalled-plugin case below restores the real
  // oracle to prove the refusal is the DEFAULT, not the seam.
  setNetworkOriginsResolveForTests(() => true);
});

afterEach(() => {
  setNetworkOriginsResolveForTests(null);
  resetOriginRegistryForTests();
});

describe("originsOf", () => {
  it("trusts a private network's addresses whether or not the record says published", () => {
    const record = { published: false, addresses: [magic, ip] };
    expect(originsOf({ exposure: "private" }, record)).toEqual(["https://box.ts.net", "http://100.64.0.7:3080"]);
  });
  it("trusts a public-with-gate network's addresses only from a published record", () => {
    expect(originsOf({ exposure: "public-with-gate" }, { published: false, addresses: [magic] })).toEqual([]);
    expect(originsOf({ exposure: "public-with-gate" }, { published: true, addresses: [magic] })).toEqual([magic.url]);
  });
  it("trusts nothing for a plugin with no network manifest", () => {
    expect(originsOf(undefined, { published: true, addresses: [magic] })).toEqual([]);
  });
});

describe("observeNetworkStatus", () => {
  it("records the addresses of a joined read and trusts them", async () => {
    const plugin = id();
    await observeNetworkStatus(plugin, { exposure: "private" }, status("joined"));
    expect((await readNetworkState(plugin)).addresses).toEqual([magic, ip]);
    expect((await readNetworkState(plugin)).published).toBe(false);
    expect(originRegistry().pluginOrigins(plugin)).toEqual([magic.url, ip.url]);
    await clearNetworkState(plugin);
  });

  it("ignores a read below joined, keeping the last known addresses and their trust", async () => {
    const plugin = id();
    await observeNetworkStatus(plugin, { exposure: "private" }, status("published"));
    await observeNetworkStatus(plugin, { exposure: "private" }, status("daemon-down", []));
    expect((await readNetworkState(plugin)).addresses).toEqual([magic, ip]);
    expect(originRegistry().has(ip.url)).toBe(true);
    await clearNetworkState(plugin);
  });

  it("does not rewrite the record when the addresses are unchanged", async () => {
    // This runs on every uncached probe; a rename per three-second poll for
    // no change would be churn, so the write is gated on a fingerprint.
    const plugin = id();
    await observeNetworkStatus(plugin, { exposure: "private" }, status("joined"));
    const before = statSync(networkStatePath(plugin)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await observeNetworkStatus(plugin, { exposure: "private" }, status("joined"));
    expect(statSync(networkStatePath(plugin)).mtimeMs).toBe(before);
    await clearNetworkState(plugin);
  });

  it("an observation for a DISABLED plugin writes nothing and trusts nothing", async () => {
    // The finding (I-1): a disable must be a real stop for the allowlist too.
    // A plugin the refresher captured while enabled, probed for seconds, and
    // observed after the disable must leave both the record and the registry
    // exactly as the disable route left them.
    const plugin = id();
    const state = new PluginStateRepository(db);
    await state.setEnabled(plugin, false);
    await observeNetworkStatus(plugin, { exposure: "private" }, status("joined"));
    expect(existsSync(networkStatePath(plugin))).toBe(false);
    expect(originRegistry().pluginOrigins(plugin)).toEqual([]);
    await state.clear(plugin);
  });

  it("an observation for an UNRESOLVABLE plugin writes nothing and populates no registry set", async () => {
    // Uninstall's guard: a cleared `plugin_state` row reads as ENABLED (the
    // absent-row default), so only loadability sees that the plugin is gone.
    // This case runs on the REAL oracle (seam restored), with a synthetic id
    // the real registry cannot resolve — the refusal is the production
    // default, not a rigged seam. The set was empty before and must stay
    // silent: no entry, not even an empty one written through the guarded
    // writer, and no record file.
    setNetworkOriginsResolveForTests(null);
    const plugin = id();
    await observeNetworkStatus(plugin, { exposure: "private" }, status("joined"));
    expect(existsSync(networkStatePath(plugin))).toBe(false);
    expect(originRegistry().pluginOrigins(plugin)).toEqual([]);
  });

  it("a disable that lands mid-observation is not undone by the in-flight probe", async () => {
    // The exact interleaving: the observation passes its entry check while
    // the plugin is still enabled, then a FULL disable completes — flag flip,
    // record clear, registry forget, in the order the disable route keeps
    // inside its lock — before the observation reaches its registry write.
    // The synchronous enabled check with no await before that write is what
    // refuses it. Without the guard this goes red: the disable's fs writes
    // are queued ahead of the observation's, so its forget lands first and
    // the unguarded write would re-populate the set after it.
    const plugin = id();
    const state = new PluginStateRepository(db);
    const observation = observeNetworkStatus(plugin, { exposure: "private" }, status("joined"));
    // The cache flip inside `setEnabled` is synchronous, so it is durable
    // the moment this line runs — while the observation is still awaiting
    // its record read.
    await state.setEnabled(plugin, false);
    await writeNetworkState(plugin, { addresses: [] });
    forgetNetworkOrigins(plugin);
    await observation;
    expect(originRegistry().pluginOrigins(plugin)).toEqual([]);
    await state.clear(plugin);
    await clearNetworkState(plugin);
  });
});

describe("syncNetworkOrigins / forgetNetworkOrigins", () => {
  it("derives from the record, so a public-with-gate plugin appears at publish and leaves at unpublish", async () => {
    const plugin = id();
    await writeNetworkState(plugin, { published: false, port: null, addresses: [magic] });
    await syncNetworkOrigins(plugin, { exposure: "public-with-gate" });
    expect(originRegistry().pluginOrigins(plugin)).toEqual([]);
    await writeNetworkState(plugin, { published: true, port: 3080 });
    await syncNetworkOrigins(plugin, { exposure: "public-with-gate" });
    expect(originRegistry().pluginOrigins(plugin)).toEqual([magic.url]);
    forgetNetworkOrigins(plugin);
    expect(originRegistry().pluginOrigins(plugin)).toEqual([]);
    await clearNetworkState(plugin);
  });
});
