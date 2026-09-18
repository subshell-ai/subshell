import { describe, expect, it } from "bun:test";
import { dropBrokenMouseReports } from "@/lib/terminal-input";

const ESC = "";

describe("dropBrokenMouseReports", () => {
  it("drops the exact frame from the 2026-09-18 phone report", () => {
    // xterm's inertia frames report a wheel event at coordinates it never
    // had; untouched, the harness printed the tail of this into its prompt.
    expect(dropBrokenMouseReports(`${ESC}[<65;NaN;NaNM`)).toBe("");
    expect(dropBrokenMouseReports(`${ESC}[<64;NaN;NaNM`)).toBe("");
  });

  it("drops every other non-decimal spelling a coordinate can take", () => {
    for (const bad of ["Infinity", "-Infinity", "-1", "1.5", "", "undefined", "1e3"]) {
      expect(dropBrokenMouseReports(`${ESC}[<0;${bad};12M`)).toBe("");
      expect(dropBrokenMouseReports(`${ESC}[<0;12;${bad}M`)).toBe("");
      expect(dropBrokenMouseReports(`${ESC}[<${bad};12;12M`)).toBe("");
    }
  });

  it("keeps well-formed reports — a real swipe still scrolls the pane", () => {
    // The frames while the finger is DOWN carry coordinates and are the
    // scroll; only the momentum frames are broken. Dropping both would trade
    // one bug for a dead gesture.
    for (const good of [`${ESC}[<65;40;12M`, `${ESC}[<64;1;1M`, `${ESC}[<0;80;24m`, `${ESC}[<0;0;0M`]) {
      expect(dropBrokenMouseReports(good)).toBe(good);
    }
  });

  it("leaves ordinary keystrokes exactly as typed", () => {
    for (const keys of ["a", "hello world", "\r", "", `${ESC}[A`, `${ESC}[5~`, `${ESC}`, "", "/tmp/x"]) {
      expect(dropBrokenMouseReports(keys)).toBe(keys);
    }
  });

  it("never eats a paste that happens to contain the report shape", () => {
    const pasted = `${ESC}[200~echo "${ESC}[<0;10;10M"${ESC}[201~`;
    expect(dropBrokenMouseReports(pasted)).toBe(pasted);
  });

  it("removes only the broken report when a payload carries several", () => {
    const mixed = `${ESC}[<65;40;12M${ESC}[<65;NaN;NaNM${ESC}[<65;41;12M`;
    expect(dropBrokenMouseReports(mixed)).toBe(`${ESC}[<65;40;12M${ESC}[<65;41;12M`);
  });

  it("does not let a broken report swallow the keystrokes around it", () => {
    expect(dropBrokenMouseReports(`ab${ESC}[<65;NaN;NaNMcd`)).toBe("abcd");
  });

  it("is repeatable — the shared regex carries no state between calls", () => {
    const frame = `${ESC}[<65;NaN;NaNM`;
    for (let i = 0; i < 5; i++) expect(dropBrokenMouseReports(frame)).toBe("");
    const good = `${ESC}[<65;40;12M`;
    for (let i = 0; i < 5; i++) expect(dropBrokenMouseReports(good)).toBe(good);
  });
});
