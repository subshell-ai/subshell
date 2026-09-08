import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { computeInsets, useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets";

describe("computeInsets", () => {
  it("rounds the visible height and clamps the pan offset at zero", () => {
    expect(computeInsets({ height: 852, offsetTop: 0 })).toEqual({
      heightPx: 852,
      offsetYpx: 0,
    });
    expect(computeInsets({ height: 419.6, offsetTop: 32 })).toEqual({
      heightPx: 420,
      offsetYpx: 32,
    });
    expect(computeInsets({ height: -4, offsetTop: -10 })).toEqual({ heightPx: 0, offsetYpx: 0 });
  });
});

describe("useVisualViewportInsets", () => {
  const w = window as unknown as Record<string, unknown>;
  const originals: Record<string, unknown> = {
    visualViewport: w.visualViewport,
    matchMedia: w.matchMedia,
  };
  afterEach(() => {
    cleanup();
    w.visualViewport = originals.visualViewport;
    w.matchMedia = originals.matchMedia;
  });

  it("is null without a visualViewport (happy-dom default)", () => {
    expect(renderHook(() => useVisualViewportInsets()).result.current).toBeNull();
  });

  it("is null on a fine pointer even with a visualViewport", () => {
    w.visualViewport = {
      height: 500,
      offsetTop: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(renderHook(() => useVisualViewportInsets()).result.current).toBeNull();
  });

  it("releases the pin (full-height fallback) when the keyboard is closed and unpanned", () => {
    w.matchMedia = (q: string) => ({
      matches: q === "(pointer: coarse)",
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    // happy-dom's innerHeight is 768 — a nearly-equal visualViewport means
    // NO keyboard; the shell must fall back to h-dvh full height instead of
    // shrinking to the (possibly chrome-reduced) viewport report.
    w.visualViewport = {
      height: 768,
      offsetTop: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(renderHook(() => useVisualViewportInsets()).result.current).toBeNull();
    // ...but a genuine keyboard (or a residual pan) keeps the pin.
    let _resize: (() => void) | null = null;
    w.visualViewport = {
      height: 400,
      offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => {
        if (_) _resize = fn;
      },
      removeEventListener: () => {},
    };
    const { result, rerender } = renderHook(() => useVisualViewportInsets());
    expect(result.current).toEqual({ heightPx: 400, offsetYpx: 0 });
    void rerender;
  });

  it("tracks a coarse-pointer visualViewport, resize included", () => {
    w.matchMedia = (q: string) => ({
      matches: q === "(pointer: coarse)",
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    let onResize: (() => void) | null = null;
    const vv = {
      height: 420,
      offsetTop: 40,
      addEventListener: (ev: string, fn: () => void) => {
        if (ev === "resize") onResize = fn;
      },
      removeEventListener: () => {},
    };
    w.visualViewport = vv;
    const { result } = renderHook(() => useVisualViewportInsets());
    expect(result.current).toEqual({ heightPx: 420, offsetYpx: 40 });
    vv.height = 300;
    // The resize callback fires outside React's batching; act() flushes the
    // resulting state update so the assertion below sees the new render.
    act(() => onResize?.());
    expect(result.current).toEqual({ heightPx: 300, offsetYpx: 40 });
  });
});
