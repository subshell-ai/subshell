import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useHasSidebar } from "@/hooks/use-has-sidebar";
import { SIDEBAR_MIN_WIDTH, WORKSPACE_TILING_MIN_WIDTH } from "@/lib/breakpoints";

/**
 * Answer every media query this hook asks from one viewport + pointer, so a
 * case reads as "a 400px phone" rather than as a list of matcher booleans.
 */
function stubViewport({ width, coarse }: { width: number; coarse: boolean }) {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = min ? width >= Number(min[1]) : query.includes("coarse") && coarse;
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  };
}

const hasSidebar = () => renderHook(() => useHasSidebar()).result.current;

describe("useHasSidebar", () => {
  const original = window.matchMedia;
  afterEach(() => {
    cleanup();
    (window as unknown as { matchMedia: unknown }).matchMedia = original;
  });

  // The whole point of the lower breakpoint: a window two thirds of the
  // tiling width keeps its navigation, where it used to have to be wide
  // enough for a split workspace first.
  it("keeps the rail in a window too narrow to tile", () => {
    stubViewport({ width: 700, coarse: false });
    expect(hasSidebar()).toBe(true);
  });

  // The measured case (2026-09-13): a 637px window still gave 240px of it to
  // the rail. Below the breakpoint the drawer is the right chrome.
  it("drops the rail once it would cost a third of the window", () => {
    stubViewport({ width: 637, coarse: false });
    expect(hasSidebar()).toBe(false);
  });

  it("drops the rail only below the sidebar breakpoint", () => {
    stubViewport({ width: SIDEBAR_MIN_WIDTH, coarse: false });
    expect(hasSidebar()).toBe(true);
    stubViewport({ width: SIDEBAR_MIN_WIDTH - 1, coarse: false });
    expect(hasSidebar()).toBe(false);
  });

  // A phone is ~390 CSS pixels wide and clears the sidebar breakpoint easily.
  // Width alone would hand it a 240px rail over a strip of content; the
  // pointer is what keeps it on the drawer, unchanged.
  it("keeps a touch device on the drawer until the tiling width", () => {
    stubViewport({ width: 390, coarse: true });
    expect(hasSidebar()).toBe(false);
    // A portrait tablet clears the sidebar breakpoint and still gets the
    // drawer, which is exactly the behaviour it has today.
    stubViewport({ width: 820, coarse: true });
    expect(hasSidebar()).toBe(false);
    stubViewport({ width: WORKSPACE_TILING_MIN_WIDTH - 1, coarse: true });
    expect(hasSidebar()).toBe(false);
    stubViewport({ width: WORKSPACE_TILING_MIN_WIDTH, coarse: true });
    expect(hasSidebar()).toBe(true);
  });

  // Tiling needs room for two 80-column terminals; a nav rail does not. They
  // shared one number, which is what made the window have to be workspace-wide
  // before it was allowed to show its own navigation.
  it("is two thirds of the tiling breakpoint", () => {
    expect(SIDEBAR_MIN_WIDTH).toBe(Math.round((WORKSPACE_TILING_MIN_WIDTH * 2) / 3));
  });
});
