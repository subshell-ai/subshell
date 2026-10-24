import { describe, expect, it } from "bun:test";
import { findUrlsInLine, stripTrailingJunk } from "../pane-url.js";

describe("findUrlsInLine", () => {
  it("finds the one URL on a plain line", () => {
    const line = "Release notes: https://github.com/subshell-ai/subshell/releases";
    const spans = findUrlsInLine(line);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.url).toBe("https://github.com/subshell-ai/subshell/releases");
    expect(spans[0]!.start).toBe(line.indexOf("https"));
    expect(line.slice(spans[0]!.start, spans[0]!.end)).toBe(spans[0]!.url);
  });

  it("trims trailing prose punctuation out of the span", () => {
    const line = "See https://example.com/docs, then rerun.";
    const spans = findUrlsInLine(line);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.url).toBe("https://example.com/docs");
    // The span indexes the SOURCE line, so a renderer can slice text around it.
    expect(line.slice(spans[0]!.start, spans[0]!.end)).toBe("https://example.com/docs");
    expect(line.slice(spans[0]!.end)).toBe(", then rerun.");
  });

  it("keeps a query string but drops a sentence's final period", () => {
    const spans = findUrlsInLine("open https://example.com/search?q=subshell.");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.url).toBe("https://example.com/search?q=subshell");
  });

  it("reads several URLs in order with non-overlapping spans", () => {
    const line = "https://a.example/1 then https://b.example/2!";
    const spans = findUrlsInLine(line);
    expect(spans.map((s) => s.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
    expect(spans[0]!.end).toBeLessThanOrEqual(spans[1]!.start);
  });

  it("matches the scheme in any case", () => {
    const spans = findUrlsInLine("HTTPS://Example.COM/Path");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.url).toBe("HTTPS://Example.COM/Path");
  });

  it("ignores anything that is not http(s)", () => {
    expect(findUrlsInLine("mailto:someone@example.com ftp://files/x")).toEqual([]);
    expect(findUrlsInLine("no links here")).toEqual([]);
    expect(findUrlsInLine("")).toEqual([]);
  });

  it("strips a cat -v control notation off the end", () => {
    const line = "https://example.com/a^M";
    const spans = findUrlsInLine(line);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.url).toBe("https://example.com/a");
    expect(spans[0]!.end).toBe(line.length - 2);
  });
});

describe("stripTrailingJunk", () => {
  it("reads the control notation before the punctuation", () => {
    // DEL's spelling `^?`: stripping the `?` as punctuation first would
    // dissolve the pair and leave a stray caret.
    expect(stripTrailingJunk("https://example.com/a^?")).toBe("https://example.com/a");
    expect(stripTrailingJunk("https://example.com/a^M.")).toBe("https://example.com/a");
    expect(stripTrailingJunk("https://example.com/a.^M")).toBe("https://example.com/a");
  });

  it("keeps a bare caret and notations inside the value", () => {
    expect(stripTrailingJunk("https://example.com/a^")).toBe("https://example.com/a^");
    expect(stripTrailingJunk("https://example.com/a^Mb")).toBe("https://example.com/a^Mb");
  });
});
