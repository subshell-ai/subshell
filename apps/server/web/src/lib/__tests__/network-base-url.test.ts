import { describe, expect, it } from "bun:test";
import { baseUrlLine } from "@/lib/network-base-url";
import type { NetworkRow } from "@/types/network";

/** The smallest row that carries an address list; the rest is fixture noise. */
function row(id: string, name: string, urls: string[]): NetworkRow {
  return {
    id,
    name,
    description: "",
    exposure: "private",
    labels: {},
    platforms: ["darwin"],
    supported: true,
    enabled: true,
    interactiveLogin: false,
    publishImplicit: false,
    privileged: [],
    settingsFields: [],
    settings: {},
    published: urls.length > 0,
    status: {
      state: urls.length > 0 ? "joined" : "needs-login",
      addresses: urls.map((url) => ({ url, scheme: "http", label: "test", secureContext: false })),
      hints: [],
    },
  };
}

describe("baseUrlLine", () => {
  const TS = "http://box.tail1234.ts.net:3080";
  const NB = "http://nb.disaresta.internal:3080";

  it("attributes a running base URL to the network whose address it is", () => {
    const line = baseUrlLine(TS, TS, [row("netbird", "NetBird", [NB]), row("tailscale", "Tailscale", [TS])]);
    expect(line).toEqual({ running: TS, runningOn: "Tailscale", pending: null, pendingOn: null });
  });

  it("names the pending half and its network when saved differs from running", () => {
    const line = baseUrlLine(TS, NB, [row("netbird", "NetBird", [NB]), row("tailscale", "Tailscale", [TS])]);
    expect(line).toEqual({ running: TS, runningOn: "Tailscale", pending: NB, pendingOn: "NetBird" });
  });

  it("leaves the network unattributed when no address list claims the origin", () => {
    const line = baseUrlLine("http://localhost:3080", undefined, [row("tailscale", "Tailscale", [TS])]);
    expect(line).toEqual({ running: "http://localhost:3080", runningOn: null, pending: null, pendingOn: null });
  });

  it("says nothing when the base URL has not arrived yet", () => {
    expect(baseUrlLine(undefined, undefined, [])).toBeNull();
    expect(baseUrlLine("", undefined, [])).toBeNull();
  });

  it("compares origins, not strings — a trailing slash is still the same address", () => {
    // A SERVE address carries the port (`:3080`); a base URL usually does not
    // (a 443 serve record is the honest spelling for one), so the fixture
    // uses an https-with-slash base against the portless address it should
    // attribute to — the same origin is the whole assertion.
    const line = baseUrlLine("https://box.tail1234.ts.net/", "https://box.tail1234.ts.net/", [
      row("tailscale", "Tailscale", ["https://box.tail1234.ts.net"]),
    ]);
    expect(line).toEqual({
      running: "https://box.tail1234.ts.net/",
      runningOn: "Tailscale",
      pending: null,
      pendingOn: null,
    });
  });

  it("survives an unparseable stored value by attributing nothing", () => {
    const line = baseUrlLine("not a url", "also not", [row("tailscale", "Tailscale", [TS])]);
    expect(line).toEqual({ running: "not a url", runningOn: null, pending: "also not", pendingOn: null });
  });
});
