import { describe, expect, it } from "bun:test";
import {
  matchesStackQuery,
  type OwnStackRow,
  type StackItemRow,
  stackCountLabel,
  stackJoinedText,
  stacksWithPrompt,
} from "../prompt-stacks";

/**
 * The pure half of stacks (spec 2026-09-29): the join the picker and the
 * copy button share, the page's filter over a COLLECTION, the count line,
 * and the cross-link derivation the prompt rows read.
 */

const item = (over: Partial<StackItemRow>): StackItemRow => ({
  id: over.id ?? "i1",
  description: over.description ?? "D",
  body: over.body ?? "b",
  ...(over.promptId ? { promptId: over.promptId } : {}),
  ...(over.ownerName ? { ownerName: over.ownerName } : {}),
});

const stack = (over: Partial<OwnStackRow>): OwnStackRow => ({
  id: over.id ?? "s1",
  label: over.label ?? "Morning set",
  shared: over.shared ?? false,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: over.updatedAt ?? "2026-09-29T00:00:00.000Z",
  items: over.items ?? [],
});

describe("stackJoinedText", () => {
  it("joins members with ONE blank line, the launch rule verbatim", () => {
    const s = stack({ items: [item({ body: "one" }), item({ body: "two\nmore" }), item({ body: "three" })] });
    expect(stackJoinedText(s)).toBe("one\n\ntwo\nmore\n\nthree");
  });
  it("an empty stack joins to the empty string", () => {
    expect(stackJoinedText(stack({ items: [] }))).toBe("");
  });
});

describe("matchesStackQuery", () => {
  const s = stack({
    label: "Morning set",
    items: [item({ description: "Kickoff", body: "start the task" }), item({ description: "", body: "inline note" })],
  });
  it("blank keeps everything", () => {
    expect(matchesStackQuery(s, "   ")).toBe(true);
  });
  it("matches the label, any member's description, or any member's body", () => {
    expect(matchesStackQuery(s, "morning")).toBe(true);
    expect(matchesStackQuery(s, "kick")).toBe(true);
    expect(matchesStackQuery(s, "INLINE NOTE")).toBe(true);
  });
  it("misses when nothing in the collection carries the query", () => {
    expect(matchesStackQuery(s, "evening")).toBe(false);
  });
});

describe("stackCountLabel", () => {
  it("reads the EMPTY state exactly as the page names it", () => {
    expect(stackCountLabel([])).toBe("Empty");
  });
  it("counts members", () => {
    expect(stackCountLabel([item({})])).toBe("1 prompt");
    expect(stackCountLabel([item({ id: "a" }), item({ id: "b" })])).toBe("2 prompts");
  });
});

describe("stacksWithPrompt", () => {
  it("finds the visible stacks holding a reference member", () => {
    const a = stack({ id: "sa", items: [item({ promptId: "p1" })] });
    const b = stack({ id: "sb", items: [item({ id: "x", body: "inline, never a hit" })] });
    const c = stack({ id: "sc", items: [item({ id: "y", promptId: "p2" }), item({ id: "z", promptId: "p1" })] });
    expect(stacksWithPrompt([a, b, c], "p1").map((s) => s.id)).toEqual(["sa", "sc"]);
    expect(stacksWithPrompt([a, b, c], "nope")).toEqual([]);
  });
});
