import { describe, expect, it } from "bun:test";
import { baseUrlMove } from "@/lib/base-url-move";

/**
 * The promote-confirmation gate, tabled. Each row is the whole argument for
 * one branch of {@link baseUrlMove}; the two `null` directions (same origin,
 * loopback) are as deliberate as the move itself — see the module docblock.
 */
describe("baseUrlMove", () => {
  const NETBIRD = "http://airtop-macbook.disaresta.internal:3080";

  it("names the move when a network address would replace another network's", () => {
    expect(baseUrlMove("http://macbook-pro.tail1234.ts.net:3080", NETBIRD)).toEqual({
      fromHost: "macbook-pro.tail1234.ts.net:3080",
      toHost: "airtop-macbook.disaresta.internal:3080",
    });
  });

  it("stays silent when the base URL already IS the target", () => {
    expect(baseUrlMove(NETBIRD, NETBIRD)).toBeNull();
    // Trailing slash and default-port spellings are the same origin, so a
    // republish of the current base URL is a no-op and must not ask.
    expect(baseUrlMove("https://box.example.ts.net", "https://box.example.ts.net:443/")).toBeNull();
  });

  it("stays silent moving OFF loopback — that is the documented first promote", () => {
    for (const loop of ["http://localhost:3080", "http://127.0.0.1:3080", "http://[::1]:3080"]) {
      expect(baseUrlMove(loop, NETBIRD)).toBeNull();
    }
  });

  it("stays silent when either side is missing or unreadable", () => {
    expect(baseUrlMove(undefined, NETBIRD)).toBeNull();
    expect(baseUrlMove("http://ts.example:3080", undefined)).toBeNull();
    // A stored value the card cannot parse is not evidence of a move; the
    // publish must not be gated on a guess.
    expect(baseUrlMove("not a url", NETBIRD)).toBeNull();
    expect(baseUrlMove("http://ts.example:3080", "also not a url")).toBeNull();
  });

  it("treats a port change on the same host as a move", () => {
    expect(baseUrlMove("http://box.internal:3080", "http://box.internal:4080")).not.toBeNull();
  });
});
