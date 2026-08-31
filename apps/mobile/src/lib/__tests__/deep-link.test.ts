import { describe, expect, it } from "bun:test";
import { parseSessionDeepLink, sessionDeepLink } from "@/lib/deep-link";

const UUID = "0f12ab34-5678-49ab-8cde-0f12ab345678";

describe("parseSessionDeepLink", () => {
  it("extracts exactly a session uuid from mote://session/<id>", () => {
    expect(parseSessionDeepLink(`mote://session/${UUID}`)).toBe(UUID);
    expect(parseSessionDeepLink(`mote://session/${UUID.toUpperCase()}`)).toBe(UUID);
  });

  it("rejects junk, other hosts, and non-uuid tails (the link carries a UUID only)", () => {
    expect(parseSessionDeepLink("mote://session/../../etc")).toBeNull();
    expect(parseSessionDeepLink("mote://session/")).toBeNull();
    expect(parseSessionDeepLink(`mote://session/${UUID}/rename`)).toBeNull();
    expect(parseSessionDeepLink("mote://other/x")).toBeNull();
    expect(parseSessionDeepLink(`https://example.com/session/${UUID}`)).toBeNull();
    expect(parseSessionDeepLink("")).toBeNull();
  });
});

describe("sessionDeepLink", () => {
  it("round-trips through the parser", () => {
    expect(parseSessionDeepLink(sessionDeepLink(UUID))).toBe(UUID);
  });
});
