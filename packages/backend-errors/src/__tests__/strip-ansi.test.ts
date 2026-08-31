import { describe, expect, it } from "bun:test";
import { stripAnsi } from "../strip-ansi";

describe("stripAnsi", () => {
  it("strips SGR color sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain");
  });

  it("strips cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2Ahome")).toBe("home");
  });

  it("strips OSC title sequences", () => {
    expect(stripAnsi("\x1b]0;window title\x07body")).toBe("body");
  });

  it("strips carriage returns", () => {
    expect(stripAnsi("line1\r\nline2")).toBe("line1\nline2");
  });

  it("strips DEC private-mode sequences (alt screen)", () => {
    expect(stripAnsi("\x1b[?1049hin-alt")).toBe("in-alt");
  });

  it("strips DEC private-mode sequences (bracketed paste)", () => {
    expect(stripAnsi("\x1b[?2004hprompt")).toBe("prompt");
  });

  it("strips DEC private-mode sequences (cursor hide)", () => {
    expect(stripAnsi("\x1b[?25l text")).toBe(" text");
  });

  it("strips CSI sequences with intermediate bytes", () => {
    // ESC [ then an intermediate byte (0x20-0x2F, here " " space) then a
    // final byte (0x40-0x7E) — e.g. DECSCUSR cursor-style sequences use this
    // shape (`ESC [ n SP q`).
    expect(stripAnsi("\x1b[2 qafter")).toBe("after");
  });

  it("leaves a bare ESC with no valid sequence untouched (does not hang or over-strip)", () => {
    expect(stripAnsi("\x1bnot-a-sequence")).toBe("\x1bnot-a-sequence");
  });

  it("passes plain text through unchanged", () => {
    expect(stripAnsi("just plain text, nothing to strip")).toBe("just plain text, nothing to strip");
  });

  it("returns an empty string for an empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});
