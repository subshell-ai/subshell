import { afterEach, describe, expect, it } from "bun:test";
import { setSwipeNavEnabled, swipeNavEnabled } from "@/lib/swipe-nav-pref";

describe("swipe nav preference (per-device setting)", () => {
  const KEY = "subshell.swipeNav";
  afterEach(() => localStorage.removeItem(KEY));

  it("defaults ON — absent or garbage storage both mean on", () => {
    expect(swipeNavEnabled()).toBe(true);
    localStorage.setItem(KEY, "banana");
    expect(swipeNavEnabled()).toBe(true);
  });

  it("only the explicit off value turns it off", () => {
    localStorage.setItem(KEY, "0");
    expect(swipeNavEnabled()).toBe(false);
    localStorage.setItem(KEY, "1");
    expect(swipeNavEnabled()).toBe(true);
  });

  it("the setter persists and returns the stored state", () => {
    expect(setSwipeNavEnabled(false)).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(swipeNavEnabled()).toBe(false);
    expect(setSwipeNavEnabled(true)).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    expect(swipeNavEnabled()).toBe(true);
  });
});
