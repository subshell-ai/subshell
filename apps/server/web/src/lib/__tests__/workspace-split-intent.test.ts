import { describe, expect, it } from "bun:test";
import { parseSplitIntent } from "@/lib/workspace-split-intent";

describe("parseSplitIntent", () => {
  it("reads a subshell id and a direction off the search params", () => {
    expect(parseSplitIntent({ add: "s1", dir: "below" })).toEqual({ subshellId: "s1", direction: "below" });
  });

  it("accepts every direction the dock understands", () => {
    for (const dir of ["left", "right", "above", "below", "within"]) {
      expect(parseSplitIntent({ add: "s1", dir })).toEqual({
        subshellId: "s1",
        direction: dir as "left" | "right" | "above" | "below" | "within",
      });
    }
  });

  it("is null without an `add` — a direction alone names no subshell", () => {
    expect(parseSplitIntent({})).toBeNull();
    expect(parseSplitIntent({ dir: "left" })).toBeNull();
    expect(parseSplitIntent({ add: "" })).toBeNull();
  });

  // The id is what the intent IS; the direction is a preference, so a
  // hand-edited or stale `dir` falls back rather than dropping the split.
  it("falls back to right for a missing or unknown direction", () => {
    expect(parseSplitIntent({ add: "s1" })).toEqual({ subshellId: "s1", direction: "right" });
    expect(parseSplitIntent({ add: "s1", dir: "sideways" })).toEqual({ subshellId: "s1", direction: "right" });
    expect(parseSplitIntent({ add: "s1", dir: "" })).toEqual({ subshellId: "s1", direction: "right" });
  });

  it("ignores non-string values on either param", () => {
    expect(parseSplitIntent({ add: 7 })).toBeNull();
    expect(parseSplitIntent({ add: ["s1"] })).toBeNull();
    expect(parseSplitIntent({ add: null })).toBeNull();
    expect(parseSplitIntent({ add: undefined })).toBeNull();
    expect(parseSplitIntent({ add: "s1", dir: 3 })).toEqual({ subshellId: "s1", direction: "right" });
    expect(parseSplitIntent({ add: "s1", dir: { toString: () => "left" } })).toEqual({
      subshellId: "s1",
      direction: "right",
    });
  });
});
