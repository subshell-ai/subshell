import { describe, expect, it } from "bun:test";
import { createIntentClaim } from "@/lib/intent-claim";
import type { SplitIntent } from "@/lib/workspace-split-intent";

/**
 * The one-shot guard over a split intent (review, 2026-09-14).
 *
 * The defect it closes is not "the effect ran twice" — each presentation
 * already handled that — but "the OTHER presentation ran it once more". A
 * viewport crossing the tiling breakpoint mid-add unmounts the dock and
 * mounts the tab strip with `?add=` still in the URL; the server does not
 * dedupe pane adds, so a claim held below the swap is no guard at all.
 */

const intent: SplitIntent = { subshellId: "s-1", direction: "right" };

describe("createIntentClaim", () => {
  it("answers true once and false ever after for the same intent", () => {
    const claim = createIntentClaim();
    expect(claim(intent)).toBe(true);
    expect(claim(intent)).toBe(false);
    expect(claim(intent)).toBe(false);
  });

  // The whole point: one claim, two callers, one add.
  it("is spent for the second presentation once the first has taken it", () => {
    const claim = createIntentClaim();
    const dock = claim(intent);
    const tabs = claim(intent);
    expect([dock, tabs]).toEqual([true, false]);
  });

  it("re-arms for a NEW intent — a second split is a second add", () => {
    const claim = createIntentClaim();
    expect(claim(intent)).toBe(true);
    expect(claim({ subshellId: "s-2", direction: "below" })).toBe(true);
  });

  // The route memoizes off the search params, so identity is what says "this
  // is a different URL". An equal-but-fresh object IS a different visit.
  it("goes by identity, not by value", () => {
    const claim = createIntentClaim();
    expect(claim(intent)).toBe(true);
    expect(claim({ ...intent })).toBe(true);
  });

  it("never spends itself on the absence of a split", () => {
    const claim = createIntentClaim();
    expect(claim(null)).toBe(false);
    expect(claim(null)).toBe(false);
    // An ordinary visit that later gains an intent still gets its one add.
    expect(claim(intent)).toBe(true);
  });
});
