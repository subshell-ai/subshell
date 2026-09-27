import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useIsPhoneLayout } from "@/hooks/use-is-phone-layout";
import { WORKSPACE_TILING_MIN_WIDTH } from "@/lib/breakpoints";

/**
 * Answer every media query from one viewport + pointer, the same shape
 * `use-has-sidebar.test.ts` stubs: a case reads as "a 400px mouse window",
 * never as matcher booleans.
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

const phoneLayout = () => renderHook(() => useIsPhoneLayout()).result.current;

describe("useIsPhoneLayout", () => {
  const original = window.matchMedia;
  afterEach(() => {
    cleanup();
    (window as unknown as { matchMedia: unknown }).matchMedia = original;
  });

  // The bug this rule exists for (operator, 2026-09-27): a desktop browser
  // under the tiling width in CSS px — zoom, HiDPI scaling, a deliberately
  // narrow window — must keep the dock with its draggable tabs, not the
  // phone's tap-only strip.
  it("is NOT the phone layout on a narrow desktop window", () => {
    stubViewport({ width: 500, coarse: false });
    expect(phoneLayout()).toBe(false);
    stubViewport({ width: WORKSPACE_TILING_MIN_WIDTH - 1, coarse: false });
    expect(phoneLayout()).toBe(false);
  });

  it("is the phone layout on a touch device below the tiling width", () => {
    stubViewport({ width: 390, coarse: true });
    expect(phoneLayout()).toBe(true);
    stubViewport({ width: 820, coarse: true });
    expect(phoneLayout()).toBe(true);
  });

  // A touch tablet wide enough to tile gets the real presentation, exactly
  // as width alone decided it before; the pointer only ADDED the narrow
  // desktop case, it took nothing away.
  it("stops being the phone layout at the tiling width, pointer or no pointer", () => {
    stubViewport({ width: WORKSPACE_TILING_MIN_WIDTH, coarse: true });
    expect(phoneLayout()).toBe(false);
    stubViewport({ width: WORKSPACE_TILING_MIN_WIDTH, coarse: false });
    expect(phoneLayout()).toBe(false);
  });
});
