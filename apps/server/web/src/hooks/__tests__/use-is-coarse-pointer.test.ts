import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";

/** Replace the global test-setup matchMedia stub with a fixed answer. */
function stubMatches(matches: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches,
    media: "(pointer: coarse)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

describe("useIsCoarsePointer", () => {
  const original = window.matchMedia;
  afterEach(() => {
    cleanup();
    (window as unknown as { matchMedia: unknown }).matchMedia = original;
  });

  it("reports coarse when the media query matches", () => {
    stubMatches(true);
    expect(renderHook(() => useIsCoarsePointer()).result.current).toBe(true);
  });

  it("reports fine otherwise (the test-setup default)", () => {
    expect(renderHook(() => useIsCoarsePointer()).result.current).toBe(false);
  });
});
