import { describe, expect, it } from "bun:test";
import { indexedColor, parseAnsi } from "../ansi";

/** Builds an SGR escape, keeping the tests readable. */
function sgr(params: string): string {
  return `\x1b[${params}m`;
}

describe("parseAnsi", () => {
  it("returns one span of plain text when there are no escapes", () => {
    expect(parseAnsi("hello world")).toEqual([[{ text: "hello world" }]]);
  });

  it("leaves square brackets in ordinary text alone", () => {
    // The escape prefix is what makes a CSI sequence; matching a bare "["
    // would eat the level out of every log line.
    expect(parseAnsi("[INFO] ready [1]")).toEqual([[{ text: "[INFO] ready [1]" }]]);
  });

  it("splits a line into styled runs", () => {
    const [line] = parseAnsi(`plain ${sgr("31")}red${sgr("0")} plain`);
    expect(line).toEqual([{ text: "plain " }, { text: "red", color: "#cd3131" }, { text: " plain" }]);
  });

  it("applies bright colours, bold and underline", () => {
    const [line] = parseAnsi(`${sgr("1;4;92")}go`);
    expect(line).toEqual([{ text: "go", color: "#23d18b", bold: true, underline: true }]);
  });

  it("resets everything on SGR 0 and on a bare escape", () => {
    const [withZero] = parseAnsi(`${sgr("1;31")}a${sgr("0")}b`);
    expect(withZero[1]).toEqual({ text: "b" });

    const [bare] = parseAnsi(`${sgr("1;31")}a${sgr("")}b`);
    expect(bare[1]).toEqual({ text: "b" });
  });

  it("turns individual attributes off without clearing the rest", () => {
    const [line] = parseAnsi(`${sgr("1;31")}a${sgr("22")}b`);
    expect(line[0]).toEqual({ text: "a", color: "#cd3131", bold: true });
    // 22 clears bold and dim only — the colour survives.
    expect(line[1]).toEqual({ text: "b", color: "#cd3131" });
  });

  it("reads 256-colour and truecolour foregrounds without leaking their parameters", () => {
    // The trailing "1" would read as bold if the extended parameters were
    // not consumed as a unit.
    const [indexed] = parseAnsi(`${sgr("38;5;196")}x`);
    expect(indexed[0].color).toBe("rgb(255, 0, 0)");
    expect(indexed[0].bold).toBeUndefined();

    const [truecolor] = parseAnsi(`${sgr("38;2;10;20;30;1")}y`);
    expect(truecolor[0].color).toBe("rgb(10, 20, 30)");
    expect(truecolor[0].bold).toBe(true);
  });

  it("reads an extended background", () => {
    const [line] = parseAnsi(`${sgr("48;5;21")}x`);
    expect(line[0].background).toBe("rgb(0, 0, 255)");
  });

  it("swaps foreground and background under inverse", () => {
    const [line] = parseAnsi(`${sgr("31;47;7")}x`);
    expect(line[0]).toMatchObject({ color: "#e5e5e5", background: "#cd3131" });
  });

  it("carries styling across lines", () => {
    // tmux emits an escape only when something changes, so a colour opened at
    // the end of one line is still in effect on the next.
    const lines = parseAnsi(`${sgr("31")}red\nstill red`);
    expect(lines[0][0].color).toBe("#cd3131");
    expect(lines[1][0].color).toBe("#cd3131");
  });

  it("drops non-SGR CSI sequences without emitting their bytes", () => {
    const [line] = parseAnsi("a\x1b[2Kb\x1b[10;5Hc");
    expect(line.map((s) => s.text).join("")).toBe("abc");
  });

  it("yields an empty span list for an empty line", () => {
    expect(parseAnsi("a\n\nb")).toEqual([[{ text: "a" }], [], [{ text: "b" }]]);
  });

  it("keeps a screen with no trailing newline intact", () => {
    expect(parseAnsi("one\ntwo").length).toBe(2);
  });
});

describe("indexedColor", () => {
  it("maps the first 16 to the base palette", () => {
    expect(indexedColor(0)).toBe("#000000");
    expect(indexedColor(9)).toBe("#f14c4c");
  });

  it("maps the colour cube using xterm's ramp", () => {
    expect(indexedColor(16)).toBe("rgb(0, 0, 0)");
    expect(indexedColor(231)).toBe("rgb(255, 255, 255)");
  });

  it("maps the grayscale ramp", () => {
    expect(indexedColor(232)).toBe("rgb(8, 8, 8)");
    expect(indexedColor(255)).toBe("rgb(238, 238, 238)");
  });

  it("returns undefined outside the palette", () => {
    expect(indexedColor(-1)).toBeUndefined();
    expect(indexedColor(256)).toBeUndefined();
  });
});
