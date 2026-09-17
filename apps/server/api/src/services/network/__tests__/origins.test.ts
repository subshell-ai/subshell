import { afterEach, describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import type { NetworkAddress, NetworkStatus } from "@internal/pane-runtime";
import {
  forgetNetworkOrigins,
  observeNetworkStatus,
  originsOf,
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

afterEach(() => resetOriginRegistryForTests());

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
