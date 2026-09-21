import { describe, expect, it } from "bun:test";
import {
  andList,
  disableDescription,
  disabledLine,
  leftLine,
  publishedLine,
  unpublishedLine,
} from "@/lib/network-result-copy";

/**
 * The grammar every network result speaks: outcome first, no key or file
 * named, PRESENT tense — the server trusts a network's addresses the moment
 * the plugin reports them and stops the moment they are unpublished, left or
 * disabled, so nothing here may promise a restart.
 */
describe("andList", () => {
  it("joins one, two and many without borrowing another form's comma", () => {
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b"])).toBe("a and b");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("publishedLine", () => {
  it("says where the other devices can sign in, now", () => {
    expect(publishedLine("Tailscale", ["https://box.tail1234.ts.net", "http://100.64.0.1:3080"])).toBe(
      "Published on Tailscale: your other devices can sign in at https://box.tail1234.ts.net and http://100.64.0.1:3080 now.",
    );
  });
  it("announces a publish that reported no address without inventing one", () => {
    expect(publishedLine("Tailscale", [])).toBe("Published on Tailscale.");
  });
  it("never promises a restart", () => {
    expect(publishedLine("Tailscale", ["https://a"])).not.toMatch(/restart/i);
  });
});

describe("unpublishedLine / leftLine", () => {
  it("names the origins that no longer accept sign-ins, agreeing in number", () => {
    expect(unpublishedLine("Tailscale", ["https://box.tail1234.ts.net"])).toBe(
      "Stopped publishing on Tailscale: https://box.tail1234.ts.net no longer accepts sign-ins.",
    );
    expect(leftLine("NetBird", ["http://nb.internal", "http://100.64.0.1:3080"])).toBe(
      "Left NetBird: http://nb.internal and http://100.64.0.1:3080 no longer accept sign-ins.",
    );
  });
  it("says plainly when the act had nothing recorded to take back", () => {
    expect(unpublishedLine("NetBird", [])).toBe(
      "Stopped publishing on NetBird: the addresses this server accepts sign-in from are unchanged.",
    );
    expect(leftLine("Tailscale", [])).toBe("Left Tailscale.");
  });
});

describe("disabledLine", () => {
  it("counts the addresses when the row carries them, and omits the number when it does not", () => {
    expect(disabledLine(2)).toBe("Disabled: its 2 addresses are not offered or trusted.");
    expect(disabledLine(1)).toBe("Disabled: its address is not offered or trusted.");
    expect(disabledLine(0)).toBe("Disabled: its addresses are not offered or trusted.");
    expect(disabledLine(undefined)).toBe("Disabled: its addresses are not offered or trusted.");
  });
});

describe("disableDescription", () => {
  it("names what stops being trusted, and the publish that stops with it", () => {
    expect(disableDescription("Tailscale", ["https://a", "http://b"], false)).toBe(
      "https://a and http://b stop being offered and trusted for sign-in now. Enable it again from this card.",
    );
    expect(disableDescription("Tailscale", ["https://a"], true)).toBe(
      "This server stops publishing on Tailscale, and https://a stops being offered and trusted for sign-in now. Enable it again from this card.",
    );
  });
});
