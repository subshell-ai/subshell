import { beforeEach, describe, expect, it } from "bun:test";
import {
  markNoticeSeen,
  noticeSeen,
  resetSeenNotices,
  setTrustBannersEnabled,
  trustBannersEnabled,
} from "@/lib/trust-notice-prefs";

const BANNERS_KEY = "subshell.trustBanners";
const SEEN_KEY = "subshell.trustNoticesSeen";

describe("trust banner master switch", () => {
  beforeEach(() => localStorage.clear());

  it("defaults on", () => {
    expect(trustBannersEnabled()).toBe(true);
  });

  it("round-trips a choice and reports what was stored", () => {
    expect(setTrustBannersEnabled(false)).toBe(false);
    expect(trustBannersEnabled()).toBe(false);
    expect(setTrustBannersEnabled(true)).toBe(true);
    expect(trustBannersEnabled()).toBe(true);
  });

  it("reads any unrecognized value as on — the safe direction for a warning", () => {
    localStorage.setItem(BANNERS_KEY, "yes-please");
    expect(trustBannersEnabled()).toBe(true);
  });
});

describe("seen-marks", () => {
  beforeEach(() => localStorage.clear());

  it("remembers a mark and keeps others untouched", () => {
    expect(noticeSeen("shared:s1:1:false")).toBe(false);
    markNoticeSeen("shared:s1:1:false");
    expect(noticeSeen("shared:s1:1:false")).toBe(true);
    expect(noticeSeen("shared:s1:4:false")).toBe(false);
  });

  it("is idempotent", () => {
    markNoticeSeen("a");
    markNoticeSeen("a");
    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]")).toEqual(["a"]);
  });

  it("caps the set, evicting the oldest marks first", () => {
    for (let i = 0; i < 320; i++) markNoticeSeen(`key-${i}`);
    const stored = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[];
    expect(stored).toHaveLength(300);
    // The most recent survive; the oldest fall off (worst case: a very old
    // subshell shows its banner once more).
    expect(stored.at(-1)).toBe("key-319");
    expect(stored).not.toContain("key-0");
  });

  it("survives a corrupt or hand-edited store instead of throwing", () => {
    localStorage.setItem(SEEN_KEY, "{not json");
    expect(noticeSeen("a")).toBe(false);
    markNoticeSeen("a");
    expect(noticeSeen("a")).toBe(true);

    // A well-formed but wrong-shaped value is filtered, not trusted.
    localStorage.setItem(SEEN_KEY, JSON.stringify([1, null, "b"]));
    expect(noticeSeen("b")).toBe(true);
    expect(noticeSeen("1")).toBe(false);
  });

  it("forgets everything on reset, so re-enabling means 'start reminding me'", () => {
    markNoticeSeen("a");
    markNoticeSeen("b");
    resetSeenNotices();
    expect(noticeSeen("a")).toBe(false);
    expect(noticeSeen("b")).toBe(false);
  });
});
