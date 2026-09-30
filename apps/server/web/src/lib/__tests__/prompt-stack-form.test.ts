import { describe, expect, it } from "bun:test";
import type { PromptBlock } from "../prompt-stack";
import {
  joinedMemberText,
  makePromptStackSchema,
  stackBlocksFromItems,
  stackMembersFromBlocks,
} from "../prompt-stack-form";
import type { StackItemRow } from "../prompt-stacks";

/**
 * The editor's pure conversions and its ONE validity rule (spec 2026-09-29):
 * blocks in, wire members out, exact round-trip of an unlabeled inline row,
 * and the joined-cap rule the server will also enforce.
 */

const block = (over: Partial<PromptBlock>): PromptBlock => ({
  localId: over.localId ?? "l1",
  kind: over.kind ?? "saved",
  ...(over.promptId ? { promptId: over.promptId } : {}),
  description: over.description ?? "D",
  body: over.body ?? "b",
});

const issues = (values: unknown, minItems: number): Record<string, string[]> => {
  const r = makePromptStackSchema(minItems).safeParse(values);
  if (r.success) return {};
  const out: Record<string, string[]> = {};
  for (const i of r.error.issues) {
    const key = String(i.path[0] ?? "?");
    const list = out[key] ?? [];
    list.push(i.message);
    out[key] = list;
  }
  return out;
};

describe("stackMembersFromBlocks", () => {
  it("maps saved blocks to references and custom blocks to inline text", () => {
    expect(
      stackMembersFromBlocks([
        block({ promptId: "p1" }),
        block({ kind: "custom", description: "Note", body: "my text" }),
      ]),
    ).toEqual([{ promptId: "p1" }, { body: "my text", description: "Note" }]);
  });
  it("keeps an unlabeled inline row UNLABELED (the placeholder is display, not data)", () => {
    expect(stackMembersFromBlocks([block({ kind: "custom", description: "", body: "text" })])).toEqual([
      { body: "text" },
    ]);
  });
});

describe("stackBlocksFromItems", () => {
  it("seeds refs as saved blocks and inline text as custom blocks, round-tripping the label", () => {
    const items: StackItemRow[] = [
      { id: "i1", promptId: "p1", description: "P1", body: "live" },
      { id: "i2", description: "", body: "no label" },
    ];
    const blocks = stackBlocksFromItems(items);
    expect(blocks[0]).toEqual({ localId: "i1", kind: "saved", promptId: "p1", description: "P1", body: "live" });
    expect(blocks[1]).toEqual({ localId: "i2", kind: "custom", description: "", body: "no label" });
    expect(stackMembersFromBlocks(blocks)).toEqual([{ promptId: "p1" }, { body: "no label" }]);
  });
});

describe("joinedMemberText and the schema", () => {
  it("joins members with one blank line, the server's cap arithmetic", () => {
    expect(joinedMemberText([block({ body: "a" }), block({ body: "b\nc" })])).toBe("a\n\nb\nc");
  });
  it("a birth needs one member, an edit may empty the stack", () => {
    expect(issues({ label: "L", blocks: [], shared: false }, 1).blocks).toBeDefined();
    expect(issues({ label: "L", blocks: [], shared: false }, 0).blocks).toBeUndefined();
  });
  it("refuses a blank label", () => {
    expect(issues({ label: "  ", blocks: [block({})], shared: false }, 1).label).toBeDefined();
  });
  it("refuses a label over the 120 cap (the server's StackLabel, said inline)", () => {
    expect(issues({ label: "x".repeat(121), blocks: [block({})], shared: false }, 1).label).toBeDefined();
  });
  it("refuses the joined text over the 20000 wire cap", () => {
    const big = "x".repeat(12000);
    const found = issues({ label: "L", blocks: [block({ body: big }), block({ body: big })], shared: false }, 1);
    expect(found.blocks?.[0]).toContain("20000");
  });
  it("accepts a complete draft", () => {
    expect(issues({ label: "Set", blocks: [block({})], shared: true }, 1)).toEqual({});
  });
});
