import { describe, expect, it } from "bun:test";
import { logSegments } from "../lib/log-segments";

describe("logSegments", () => {
  it("leaves a plain line one untouched run", () => {
    expect(logSegments("nothing to see")).toEqual([{ text: "nothing to see" }]);
    expect(logSegments("")).toEqual([{ text: "" }]);
  });

  it("cuts the URL out of a sentence into its own tappable run", () => {
    expect(logSegments("docs: https://example.com/guide, enjoy")).toEqual([
      { text: "docs: " },
      { text: "https://example.com/guide", url: "https://example.com/guide" },
      { text: ", enjoy" },
    ]);
  });

  it("rejoins the source line exactly, spans included", () => {
    const line = "a https://x.dev/1 b http://y.dev/2! c";
    expect(
      logSegments(line)
        .map((s) => s.text)
        .join(""),
    ).toBe(line);
  });

  it("only marks runs http(s), never a bare word", () => {
    expect(logSegments("mailto:me@x.dev ftp://z")).toEqual([{ text: "mailto:me@x.dev ftp://z" }]);
  });
});
