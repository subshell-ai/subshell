import { describe, expect, it } from "bun:test";
import { attachUrlFromQuery, parseAttachParams, UNNAMED_DEVICE } from "@/ws/attach-params.js";

/** An attach URL with the given query params. */
function url(query: Record<string, string>): URL {
  return attachUrlFromQuery({ subshell: "s1", token: "t", ...query });
}

describe("parseAttachParams — every attach input, read once", () => {
  it("reads the whole set a modern client declares", () => {
    expect(
      parseAttachParams(url({ cols: "120", rows: "40", device: "Laptop", hidden: "1", build: "a1b2c3", enc: "cbor" })),
    ).toEqual({
      size: { cols: 120, rows: 40 },
      deviceLabel: "Laptop",
      hidden: true,
      build: "a1b2c3",
      wireMode: "cbor",
    });
  });

  it("gives a client that declares nothing a complete, harmless struct", () => {
    // An older client, or a hand-built socket. Every field still has a value,
    // so a caller can never receive a half-populated set. No `enc=` means the
    // JSON wire, byte-identical to before the negotiation existed.
    expect(parseAttachParams(url({}))).toEqual({
      size: null,
      deviceLabel: UNNAMED_DEVICE,
      hidden: false,
      build: "MISSING",
      wireMode: "json",
    });
  });

  it("negotiates CBOR only on the exact value; a typo falls back to JSON", () => {
    expect(parseAttachParams(url({ enc: "cbor" })).wireMode).toBe("cbor");
    expect(parseAttachParams(url({ enc: "CBOR" })).wireMode).toBe("json");
    expect(parseAttachParams(url({ enc: "" })).wireMode).toBe("json");
  });

  it("refuses a malformed size rather than passing NaN into the sizing rule", () => {
    for (const q of [
      { cols: "0", rows: "24" },
      { cols: "80", rows: "-1" },
      { cols: "x", rows: "24" },
      { cols: "80.5", rows: "24" },
    ]) {
      expect(parseAttachParams(url(q)).size).toBeNull();
    }
  });

  it("treats only `1` and `true` as hidden", () => {
    // Absent or unrecognized means visible: clients that send no such param
    // are exactly the ones with no way to be hidden.
    expect(parseAttachParams(url({ hidden: "1" })).hidden).toBe(true);
    expect(parseAttachParams(url({ hidden: "true" })).hidden).toBe(true);
    expect(parseAttachParams(url({ hidden: "0" })).hidden).toBe(false);
    expect(parseAttachParams(url({ hidden: "yes" })).hidden).toBe(false);
  });

  it("re-normalizes the device label rather than trusting the client's", () => {
    // It is rendered in OTHER viewers' browsers — for a shared subshell that
    // can be another user — and the client's own sanitizing protects nothing
    // against a hand-built socket URL.
    expect(parseAttachParams(url({ device: "iPad\nrogue" })).deviceLabel).toBe("iPad rogue");
    expect(parseAttachParams(url({ device: "   " })).deviceLabel).toBe(UNNAMED_DEVICE);
    expect(parseAttachParams(url({ device: "x".repeat(300) })).deviceLabel.length).toBeLessThanOrEqual(40);
  });

  it("clamps and sanitizes the build id — it is logged, never decided on", () => {
    expect(parseAttachParams(url({ build: "a b/c" })).build).toBe("abc");
    expect(parseAttachParams(url({ build: "z".repeat(50) })).build).toHaveLength(24);
    expect(parseAttachParams(url({ build: "!!!" })).build).toBe("MISSING");
  });

  it("survives the round trip through Elysia's already-decoded query", () => {
    // `attachUrlFromQuery` re-encodes exactly once; a label with a space and
    // an ampersand must come back whole rather than splitting into params.
    expect(parseAttachParams(url({ device: "Theo's iPad & phone" })).deviceLabel).toBe("Theo's iPad & phone");
  });
});
