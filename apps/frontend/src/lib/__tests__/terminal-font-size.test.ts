import { afterEach, describe, expect, it } from "bun:test";
import { clampTermFont, setTerminalFontSize, TERM_FONT_EVENT, terminalFontSize } from "@/lib/terminal-font-size";

describe("terminal font size (per-device setting)", () => {
  const KEY = "subshell.termFontSize";
  afterEach(() => localStorage.removeItem(KEY));

  it("defaults to 13 and survives garbage storage", () => {
    expect(terminalFontSize()).toBe(13);
    localStorage.setItem(KEY, "banana");
    expect(terminalFontSize()).toBe(13);
  });

  it("clamps hard at both bounds", () => {
    expect(clampTermFont(2)).toBe(11);
    expect(clampTermFont(999)).toBe(22);
    expect(clampTermFont(16.4)).toBe(16);
  });

  it("persists the choice and notifies mounted terminals live", () => {
    const seen: number[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<number>).detail);
    window.addEventListener(TERM_FONT_EVENT, on);
    try {
      expect(setTerminalFontSize(17)).toBe(17);
      expect(localStorage.getItem(KEY)).toBe("17");
      expect(terminalFontSize()).toBe(17);
      expect(seen).toEqual([17]);
    } finally {
      window.removeEventListener(TERM_FONT_EVENT, on);
    }
  });
});
