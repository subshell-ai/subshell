import { describe, expect, it } from "bun:test";
import { lanOriginsFor } from "@/services/lan-origins.js";

/**
 * The machine's own LAN addresses, offered as trusted origins so a phone on
 * the same Wi-Fi can sign in without the operator first discovering the
 * 403-naming-nothing trap through a QR code that cannot work.
 *
 * Fixtures are the minimal slice of `os.networkInterfaces()` the function
 * reads — address, family, internal — so a test names the fact it exercises
 * rather than three unused fields.
 */
function iface(
  entries: Record<string, { address: string; family?: string; internal?: boolean }[]>,
): Parameters<typeof lanOriginsFor>[2] {
  return Object.fromEntries(
    Object.entries(entries).map(([name, list]) => [
      name,
      list.map((e) => ({ address: e.address, family: e.family ?? "IPv4", internal: e.internal ?? false })),
    ]),
  );
}

const TYPICAL = iface({
  lo0: [
    { address: "127.0.0.1", internal: true },
    { address: "::1", family: "IPv6", internal: true },
  ],
  en0: [{ address: "192.168.1.14" }],
});

describe("lanOriginsFor", () => {
  it("derives the non-internal IPv4 addresses on a wildcard bind", () => {
    expect(lanOriginsFor(3080, "0.0.0.0", TYPICAL)).toEqual(["http://192.168.1.14:3080"]);
  });

  it("answers nothing on a concrete or loopback bind", () => {
    // A concrete HOST already contributes its own origin via localOriginsFor,
    // and a loopback bind serves nothing on the LAN — trusting LAN addresses
    // it cannot answer for would only put dead rows in the picker.
    expect(lanOriginsFor(3080, "127.0.0.1", TYPICAL)).toEqual([]);
    expect(lanOriginsFor(3080, "192.168.1.14", TYPICAL)).toEqual([]);
  });

  it("treats every wildcard spelling as a wildcard bind", () => {
    for (const host of ["0.0.0.0", "::", "[::]", "*"]) {
      expect(lanOriginsFor(3080, host, TYPICAL)).toContain("http://192.168.1.14:3080");
    }
  });

  it("keeps several addresses across several interfaces", () => {
    const list = lanOriginsFor(
      3080,
      "0.0.0.0",
      iface({
        en0: [{ address: "192.168.1.14" }, { address: "192.168.1.15" }],
        eth0: [{ address: "10.0.0.7" }],
      }),
    );
    expect(list).toEqual(["http://192.168.1.14:3080", "http://192.168.1.15:3080", "http://10.0.0.7:3080"]);
  });

  it("skips IPv6, and IPv4 addresses that are not an address", () => {
    // 169.254/16 is what an interface with NO network self-assigns — a phone
    // pointed there reaches nothing, which is exactly the dead row this
    // picker's rules exist to prevent. 0.0.0.0 is "this host on this network".
    const list = lanOriginsFor(
      3080,
      "0.0.0.0",
      iface({
        en0: [{ address: "169.254.3.4" }, { address: "0.0.0.0" }, { address: "fd12:3456::7", family: "IPv6" }],
      }),
    );
    expect(list).toEqual([]);
  });

  it("serializes through URL.origin, so a default-port deployment is not silently inert", () => {
    // Same trap localOriginsFor records: `http://x:80` matches no Origin a
    // browser sends, because 80 is the scheme default.
    expect(lanOriginsFor(80, "0.0.0.0", TYPICAL)).toEqual(["http://192.168.1.14"]);
  });

  it("keeps a mesh address a plugin has not reported", () => {
    // 100.64/10 is the Tailscale range: a tailnet address IS dialable from
    // any device on the tailnet, whether or not the plugin is installed
    // (when it is, the registry dedupes the identical entry).
    expect(lanOriginsFor(3080, "0.0.0.0", iface({ utun4: [{ address: "100.64.0.7" }] }))).toEqual([
      "http://100.64.0.7:3080",
    ]);
  });
});
