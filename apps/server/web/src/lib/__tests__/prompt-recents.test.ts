import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadRecentPicks, recordRecentPick } from "@/lib/prompt-recents";
import type { PromptBlock } from "@/lib/prompt-stack";

/**
 * The write path of the picker's "Recently used" memory (the round-3 review
 * found only the read side pinned: every picker test seeds localStorage
 * directly, so silently dropping recordRecentPick's setItem stayed green).
 * The contract: head-insert, same-id dedup, the 24-item backlog, custom
 * blocks never remembered, and a poisoned store that reads empty and is
 * overwritten by the next pick.
 */

const KEY = "subshell/recent-prompt-picks";

function block(over: Partial<PromptBlock>): PromptBlock {
  return { localId: "l1", kind: "saved", description: "d", body: "b", ...over };
}

// The store is process-wide: a picker-driving suite run earlier in the same
// `bun test` invocation can leave real picks behind (round-4 review), so the
// precondition is established, not assumed.
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("prompt-recents write path", () => {
  it("a pick lands at the HEAD and a re-read sees the persisted list", () => {
    recordRecentPick(block({ promptId: "p1" }));
    recordRecentPick(block({ kind: "stack", stackId: "s1" }));
    expect(loadRecentPicks()).toEqual([
      { kind: "stack", id: "s1" },
      { kind: "saved", id: "p1" },
    ]);
  });

  it("re-picking an id MOVES it to the head and never duplicates it", () => {
    recordRecentPick(block({ promptId: "p1" }));
    recordRecentPick(block({ promptId: "p2" }));
    const after = recordRecentPick(block({ promptId: "p1" }));
    expect(after).toEqual([
      { kind: "saved", id: "p1" },
      { kind: "saved", id: "p2" },
    ]);
    expect(loadRecentPicks()).toEqual(after);
  });

  it("the same id under the two kinds stays two entries: a prompt and a stack are different rows", () => {
    recordRecentPick(block({ promptId: "x" }));
    recordRecentPick(block({ kind: "stack", stackId: "x" }));
    expect(loadRecentPicks()).toEqual([
      { kind: "stack", id: "x" },
      { kind: "saved", id: "x" },
    ]);
  });

  it("a custom block is ignored: nothing lands, the stored list is returned unchanged", () => {
    recordRecentPick(block({ promptId: "p1" }));
    const out = recordRecentPick(block({ kind: "custom" }));
    expect(out).toEqual([{ kind: "saved", id: "p1" }]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toEqual([{ kind: "saved", id: "p1" }]);
  });

  it("a saved-shaped block carrying no id is ignored the same way", () => {
    expect(recordRecentPick(block({}))).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("the backlog is capped at 24, oldest first off", () => {
    for (let i = 0; i < 30; i++) recordRecentPick(block({ promptId: `p${i}` }));
    const list = loadRecentPicks();
    expect(list).toHaveLength(24);
    expect(list[0]).toEqual({ kind: "saved", id: "p29" });
    expect(list[23]).toEqual({ kind: "saved", id: "p6" });
  });

  it("malformed or foreign-shaped storage reads empty, and the next pick overwrites it", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadRecentPicks()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ kind: "nonsense" }, { kind: "saved" }, "x", { kind: "stack", id: 7 }]));
    expect(loadRecentPicks()).toEqual([]);
    recordRecentPick(block({ promptId: "fresh" }));
    expect(loadRecentPicks()).toEqual([{ kind: "saved", id: "fresh" }]);
  });
});
