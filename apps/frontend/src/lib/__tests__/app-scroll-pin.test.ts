import { describe, expect, it } from "bun:test";
import { isKeyboardUp, shouldPinAppScroll } from "@/lib/app-scroll-pin";

describe("shouldPinAppScroll", () => {
  const panned = { touchUi: true, scrollTop: 34, keyboardUp: true, terminalFocused: true };

  it("pins only a panned touch scroller while the keyboard is up and the terminal is focused", () => {
    expect(shouldPinAppScroll(panned)).toBe(true);
  });

  it("never pins desktop scrolling", () => {
    expect(shouldPinAppScroll({ ...panned, touchUi: false })).toBe(false);
  });

  it("has nothing to undo at the top", () => {
    expect(shouldPinAppScroll({ ...panned, scrollTop: 0 })).toBe(false);
  });

  it("leaves list pages scrollable when no keyboard is up", () => {
    expect(shouldPinAppScroll({ ...panned, keyboardUp: false })).toBe(false);
  });

  it("does not fight scrolling while another control holds focus", () => {
    expect(shouldPinAppScroll({ ...panned, terminalFocused: false })).toBe(false);
  });
});

describe("isKeyboardUp", () => {
  it("reads the visual/layout height gap as the keyboard (iOS shrinks only one)", () => {
    expect(isKeyboardUp(450, 850)).toBe(true); // keyboard + accessory bar up
    expect(isKeyboardUp(850, 850)).toBe(false); // no keyboard
    expect(isKeyboardUp(760, 850)).toBe(false); // chrome jitter under the slack
    expect(isKeyboardUp(729, 850)).toBe(true); // just past the 120px slack
  });
});
