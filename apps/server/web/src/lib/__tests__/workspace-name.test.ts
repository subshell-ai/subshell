import { describe, expect, it } from "bun:test";
import { defaultWorkspaceName, formatWorkspaceDate, uniqueWorkspaceName } from "@/lib/workspace-name";

describe("defaultWorkspaceName", () => {
  it("is a locale stamp reaching MINUTES, not seconds", () => {
    // The whole bug is that two creates in one minute share this value; pin the
    // granularity so a silent change to add seconds is a visible test edit.
    // Assert on the CLOCK, not a separator: locales render the same instant as
    // "Sep 27, 7:38 AM" or "Sep 27 at 7:38 AM", and the bug is the minute field,
    // not the punctuation. One colon = hour:minute; a seconds field adds a second.
    const name = defaultWorkspaceName();
    expect(name).toMatch(/\d{1,2}:\d{2}/);
    expect((name.match(/:/g) ?? []).length).toBe(1);
  });
});

describe("uniqueWorkspaceName", () => {
  it("returns the base untouched when nothing collides", () => {
    expect(uniqueWorkspaceName("Alpha", ["Docs", "Rewrite"])).toBe("Alpha");
    expect(uniqueWorkspaceName("Alpha", [])).toBe("Alpha");
  });

  it("appends the smallest free counter on a collision", () => {
    expect(uniqueWorkspaceName("Alpha", ["Alpha"])).toBe("Alpha (2)");
    // Both the base and (2) taken → the next free is (3).
    expect(uniqueWorkspaceName("Alpha", ["Alpha", "Alpha (2)"])).toBe("Alpha (3)");
  });

  it("never suffixes a near-miss the server would not refuse", () => {
    // Comparison is exact: a base that only DIFFERS from a taken name is left
    // alone, so an unrelated list never mangles a perfectly good stamp.
    expect(uniqueWorkspaceName("Sep 27, 7:37 AM", ["sep 27, 7:37 am"])).toBe("Sep 27, 7:37 AM");
    expect(uniqueWorkspaceName("Sep 27, 7:37 AM", ["Sep 27, 7:37 AM "])).toBe("Sep 27, 7:37 AM");
  });

  it("treats the existing names as a set, not an index", () => {
    // Duplicates in the input do not shift the answer.
    expect(uniqueWorkspaceName("x", ["x", "x", "x (2)"])).toBe("x (3)");
  });
});

describe("formatWorkspaceDate", () => {
  it("renders a stored createdAt in the same stamp shape as a default name", () => {
    // The Drafts section labels rows with this, so a draft reads like its saved
    // siblings. Assert the clock shape (hour:minute, one colon), not a locale's
    // exact punctuation, which differs between "Sep 27, 7:38" and "Sep 27 at 7:38".
    const out = formatWorkspaceDate("2026-08-28T16:45:00.000Z");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect((out.match(/:/g) ?? []).length).toBe(1);
  });

  it("shows an unparseable stamp raw rather than blank", () => {
    expect(formatWorkspaceDate("not-a-date")).toBe("not-a-date");
  });
});
