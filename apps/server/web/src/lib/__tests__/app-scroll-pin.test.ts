import { describe, expect, it } from "bun:test";
import { isKeyboardUp, shouldResetForeignScroll } from "@/lib/app-scroll-pin";

describe("shouldResetForeignScroll", () => {
  const typing = { touchUi: true, engaged: true, insideTerminal: false };

  it("undoes any scroll outside the terminal while it is engaged", () => {
    expect(shouldResetForeignScroll(typing)).toBe(true);
  });

  it("never touches desktop scrolling", () => {
    expect(shouldResetForeignScroll({ ...typing, touchUi: false })).toBe(false);
  });

  it("leaves scrolls alone while another control holds focus (dialogs, menus)", () => {
    expect(shouldResetForeignScroll({ ...typing, engaged: false })).toBe(false);
  });

  it("always allows the terminal's own scrolling (swipe-to-read, scrollToBottom)", () => {
    expect(shouldResetForeignScroll({ ...typing, insideTerminal: true })).toBe(false);
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
