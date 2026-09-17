import { describe, expect, it } from "bun:test";
import { canonicalPluginOrigin, createOriginRegistry, type OriginRegistryDeps } from "@/services/trusted-origins.js";

/**
 * The registry is the ONE place the allowlist is assembled from its three
 * sources, so what is pinned here is the assembly: ordering, dedup, the
 * per-plugin replace-whole-set rule, and the refusal of anything a plugin
 * reports that cannot be an exact origin. Production deps are not used —
 * `readStored` and `localOrigins` are recorded fakes, so no test here reads
 * the developer's config.env.
 */
function deps(over: Partial<OriginRegistryDeps> & { stored?: string } = {}) {
  const log = { infos: [] as string[], warns: [] as string[] };
  let stored = over.stored ?? "http://localhost:5174,http://localhost:5173";
  return {
    log,
    setStored: (value: string) => {
      stored = value;
    },
    deps: {
      localOrigins: () => ["http://localhost:3080", "http://127.0.0.1:3080"],
      readStored: () => stored,
      log: { info: (m: string) => log.infos.push(m), warn: (m: string) => log.warns.push(m) },
      ...over,
    } satisfies OriginRegistryDeps,
  };
}

describe("createOriginRegistry", () => {
  it("unions local, stored and plugin origins in a stable order, deduped", () => {
    const d = deps({ stored: "http://localhost:5173,http://127.0.0.1:3080" });
    const reg = createOriginRegistry(d.deps);
    reg.setPluginOrigins("zeta", ["https://z.example"]);
    reg.setPluginOrigins("alpha", ["http://100.64.0.7:3080", "http://localhost:3080"]);
    expect(reg.current()).toEqual([
      "http://localhost:3080",
      "http://127.0.0.1:3080",
      "http://localhost:5173",
      "http://100.64.0.7:3080",
      "https://z.example",
    ]);
    const again = createOriginRegistry(d.deps);
    again.setPluginOrigins("alpha", ["http://100.64.0.7:3080", "http://localhost:3080"]);
    again.setPluginOrigins("zeta", ["https://z.example"]);
    expect(again.current()).toEqual(reg.current());
    expect(Object.isFrozen(reg.current())).toBe(true);
  });

  it("replaces a plugin's whole set, and clearing it removes every origin it alone contributed", () => {
    const reg = createOriginRegistry(deps().deps);
    reg.setPluginOrigins("tailscale", ["https://box.ts.net", "http://100.64.0.7:3080"]);
    reg.setPluginOrigins("tailscale", ["http://100.64.0.9:3080"]);
    expect(reg.has("https://box.ts.net")).toBe(false);
    expect(reg.has("http://100.64.0.9:3080")).toBe(true);
    reg.clearPlugin("tailscale");
    expect(reg.has("http://100.64.0.9:3080")).toBe(false);
    expect(reg.pluginOrigins("tailscale")).toEqual([]);
    reg.clearPlugin("never-seen"); // no-op, not a throw
  });

  it("canonicalizes a plugin's addresses and drops what cannot be an origin, with a warn naming the plugin", () => {
    const d = deps();
    const reg = createOriginRegistry(d.deps);
    reg.setPluginOrigins("netbird", [
      "https://Box.TS.NET/",
      "http://100.64.0.7:3080/path?x=1",
      "not a url",
      "https://*.ts.net",
      "http://ip?.example",
      "null",
      "",
    ]);
    expect(reg.pluginOrigins("netbird")).toEqual(["https://box.ts.net", "http://100.64.0.7:3080"]);
    expect(d.log.warns).toHaveLength(5);
    for (const w of d.log.warns) expect(w).toContain('"netbird"');
    expect(d.log.warns.some((w) => w.includes("https://*.ts.net"))).toBe(true);
  });

  it("reloadStored picks up the operator list and never touches plugin sets", () => {
    const d = deps({ stored: "http://localhost:5173" });
    const reg = createOriginRegistry(d.deps);
    reg.setPluginOrigins("p", ["https://p.example"]);
    d.setStored("http://localhost:5173, https://lan.example ,");
    reg.reloadStored();
    expect(reg.storedValue()).toBe("http://localhost:5173, https://lan.example ,");
    expect(reg.has("https://lan.example")).toBe(true);
    expect(reg.has("https://p.example")).toBe(true);
    expect(reg.current()).not.toContain("");
  });

  it("refreshLocal picks up interfaces that appeared since the registry was built", () => {
    // A laptop switches Wi-Fi; the new LAN address must reach the allowlist
    // without a restart, because the mobile dialog's whole job is naming
    // THAT address to a phone. Until the refresh is asked for, the cached
    // set is the contract — better-auth and CORS read it per request and
    // must not each pay for a re-derivation.
    let local = ["http://localhost:3080"];
    const d = deps({ localOrigins: () => local });
    const reg = createOriginRegistry(d.deps);
    local = [...local, "http://192.168.1.14:3080"];
    expect(reg.has("http://192.168.1.14:3080")).toBe(false);
    reg.refreshLocal();
    expect(reg.has("http://192.168.1.14:3080")).toBe(true);
    expect(d.log.infos.some((m) => m.includes("+http://192.168.1.14:3080"))).toBe(true);
  });

  it("refreshLocal replaces the local contribution and stays silent when nothing changed", () => {
    let local = ["http://localhost:3080", "http://192.168.1.14:3080"];
    const d = deps({ localOrigins: () => local });
    const reg = createOriginRegistry(d.deps);
    reg.setPluginOrigins("p", ["https://p.example"]);
    local = ["http://localhost:3080", "http://192.168.1.15:3080"];
    reg.refreshLocal();
    // The interface that went away stops being trusted; the plugin's set and
    // the loopback entry survive the replace.
    expect(reg.has("http://192.168.1.14:3080")).toBe(false);
    expect(reg.has("http://192.168.1.15:3080")).toBe(true);
    expect(reg.has("https://p.example")).toBe(true);
    expect(reg.has("http://localhost:3080")).toBe(true);
    const before = d.log.infos.length;
    reg.refreshLocal();
    expect(d.log.infos).toHaveLength(before);
  });

  it("logs what changed, naming the cause, and stays silent when nothing did", () => {
    const d = deps();
    const reg = createOriginRegistry(d.deps);
    expect(d.log.infos).toEqual([]);
    reg.setPluginOrigins("tailscale", ["https://box.ts.net"]);
    expect(d.log.infos).toHaveLength(1);
    expect(d.log.infos[0]).toContain('"tailscale"');
    expect(d.log.infos[0]).toContain("+https://box.ts.net");
    reg.setPluginOrigins("tailscale", ["https://box.ts.net"]);
    expect(d.log.infos).toHaveLength(1);
    reg.clearPlugin("tailscale");
    expect(d.log.infos[1]).toContain("-https://box.ts.net");
  });
});

describe("canonicalPluginOrigin", () => {
  it("serializes through URL.origin and refuses wildcards, null and non-URLs", () => {
    expect(canonicalPluginOrigin("https://Box.Example:443/x")).toBe("https://box.example");
    expect(canonicalPluginOrigin("http://[fd7a::1]:3080")).toBe("http://[fd7a::1]:3080");
    expect(canonicalPluginOrigin("https://*")).toBeNull();
    expect(canonicalPluginOrigin("null")).toBeNull();
    expect(canonicalPluginOrigin("box.example:3080")).toBeNull();
  });
});
