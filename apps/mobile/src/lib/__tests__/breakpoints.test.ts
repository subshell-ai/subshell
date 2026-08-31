import { describe, expect, it } from "bun:test";
import { isWide, TARGET_WIDTHS, WIDE_MIN_WIDTH } from "@/lib/breakpoints";

describe("isWide", () => {
  it("uses the web app's 1024px rule", () => {
    expect(WIDE_MIN_WIDTH).toBe(1024);
  });

  it("flips at the threshold, inclusive", () => {
    expect(isWide(WIDE_MIN_WIDTH - 1)).toBe(false);
    expect(isWide(WIDE_MIN_WIDTH)).toBe(true);
  });

  it("keeps iPad portrait on the phone side of the line", () => {
    // The inherited decision, restated as a test so a future "obvious" tweak
    // (e.g. 768px) has to argue with something.
    expect(isWide(TARGET_WIDTHS.phonePortrait)).toBe(false);
    expect(isWide(TARGET_WIDTHS.ipadPortrait)).toBe(false);
    expect(isWide(TARGET_WIDTHS.ipadLandscape)).toBe(true);
  });
});
