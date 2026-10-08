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

  it("strips OSC sequences terminated by ST (ESC backslash), keeping the body", () => {
    // Shell-integration output (e.g. OSC 3008/133) terminates with ST, not
    // BEL. Measured in spec 22's pane: a BEL-only regex ran past the ST
    // terminator and swallowed every byte up to the NEXT BEL, deleting the
    // line the command had just printed.
    expect(stripAnsi("\x1b]3008;start=abc;type=command\x1b\\SSH-PANE-2-OK\r\n\x1b]0;~\x07prompt")).toBe(
      "SSH-PANE-2-OK\nprompt",
    );
  });

  it("leaves an unterminated OSC (no BEL, no ST) untouched rather than swallowing the tail", () => {
    expect(stripAnsi("\x1b]66;never ended")).toBe("\x1b]66;never ended");
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
