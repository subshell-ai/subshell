import { describe, expect, it } from "bun:test";
import { type LiveClientFrame, parseLiveClientFrame } from "../live-frames.js";

describe("parseLiveClientFrame", () => {
  it("takes a previews ask, as a string and as an object", () => {
    const expected: LiveClientFrame = { type: "previews", ids: ["a", "b"] };
    expect(parseLiveClientFrame(JSON.stringify(expected))).toEqual(expected);
    expect(parseLiveClientFrame({ type: "previews", ids: ["a", "b"] })).toEqual(expected);
  });

  it("takes a resync", () => {
    expect(parseLiveClientFrame('{"type":"resync"}')).toEqual({ type: "resync" });
  });

  it("drops non-string ids rather than refusing the frame", () => {
    // A client whose list is partly junk still gets the screens it named
    // properly; the alternative is a page that silently renders none.
    expect(parseLiveClientFrame({ type: "previews", ids: ["a", 7, null, "b"] })).toEqual({
      type: "previews",
      ids: ["a", "b"],
    });
  });

  it("answers null for anything it does not recognize, and never throws", () => {
    // Client frames are untrusted input: the socket stays up and the frame is
    // ignored, exactly as the terminal socket's own parser does.
    for (const raw of ["not json", "", "null", "[]", '{"type":"input","data":"x"}', '{"type":"previews"}', 42, null]) {
      expect(parseLiveClientFrame(raw)).toBeNull();
    }
  });

  it("does not treat a previews ask with a non-array ids as an empty one", () => {
    // Returning `{ids: []}` would read downstream as "this client is showing
    // nothing", which is a different statement from a malformed frame.
    expect(parseLiveClientFrame({ type: "previews", ids: "a" })).toBeNull();
  });
});
