import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadRecentPresetPicks, recordRecentPresetPick } from "@/lib/preset-recents";

/**
 * The Preset picker's "Recently used" write path (the prompt-recents test's
 * lesson: pin the store, not just the read). The contract: head-insert,
 * same-id dedupe, the 24-id backlog, and a poisoned store that reads empty
 * and is overwritten by the next pick.
 */

const KEY = "subshell/recent-preset-picks";

// The store is process-wide: a picker-driving suite in the same invocation
// can leave real picks behind, so the precondition is established.
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("preset-recents write path", () => {
  it("a pick lands at the HEAD and a re-read sees the persisted list", () => {
    recordRecentPresetPick("p1");
    recordRecentPresetPick("p2");
    expect(loadRecentPresetPicks()).toEqual(["p2", "p1"]);
  });

  it("re-picking an id MOVES it to the head and never duplicates it", () => {
    recordRecentPresetPick("p1");
    recordRecentPresetPick("p2");
    const after = recordRecentPresetPick("p1");
    expect(after).toEqual(["p1", "p2"]);
    expect(loadRecentPresetPicks()).toEqual(["p1", "p2"]);
  });

  it("the backlog is bounded at 24", () => {
    for (let i = 0; i < 30; i++) recordRecentPresetPick(`p${i}`);
    const list = loadRecentPresetPicks();
    expect(list).toHaveLength(24);
    expect(list[0]).toBe("p29");
  });

  it("a poisoned store reads empty and the next pick overwrites it", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadRecentPresetPicks()).toEqual([]);
    recordRecentPresetPick("p1");
    expect(loadRecentPresetPicks()).toEqual(["p1"]);
  });

  it("non-string entries are dropped, surviving ids keep their order", () => {
    localStorage.setItem(KEY, JSON.stringify(["p1", 7, { a: 1 }, "p2"]));
    expect(loadRecentPresetPicks()).toEqual(["p1", "p2"]);
  });
});
