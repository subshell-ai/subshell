import { describe, expect, it } from "bun:test";
import { joinPromptBlocks, movePromptBlock, type PromptBlock, removePromptBlock } from "../prompt-stack";
import { matchesPromptQuery } from "../prompts";

const block = (id: string, body = `body of ${id}`): PromptBlock => ({
  localId: id,
  kind: "saved",
  promptId: `p-${id}`,
  description: id.toUpperCase(),
  body,
});

describe("joinPromptBlocks", () => {
  it("joins with exactly one blank line between blocks", () => {
    expect(joinPromptBlocks([block("a"), block("b"), block("c", "multi\nline")])).toBe(
      "body of a\n\nbody of b\n\nmulti\nline",
    );
  });
  it("is empty text for an empty stack (the caller then sends no prompt at all)", () => {
    expect(joinPromptBlocks([])).toBe("");
  });
});

describe("movePromptBlock", () => {
  it("swaps with the neighbour in the given direction", () => {
    const ids = movePromptBlock([block("a"), block("b"), block("c")], "b", -1).map((b) => b.localId);
    expect(ids).toEqual(["b", "a", "c"]);
    expect(movePromptBlock([block("a"), block("b"), block("c")], "b", 1).map((b) => b.localId)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
  it("is a no-op at the ends and for an unknown id", () => {
    const src = [block("a"), block("b")];
    expect(movePromptBlock(src, "a", -1).map((b) => b.localId)).toEqual(["a", "b"]);
    expect(movePromptBlock(src, "b", 1).map((b) => b.localId)).toEqual(["a", "b"]);
    expect(movePromptBlock(src, "zz", -1).map((b) => b.localId)).toEqual(["a", "b"]);
  });
});

describe("removePromptBlock", () => {
  it("drops exactly the one block", () => {
    expect(removePromptBlock([block("a"), block("b"), block("c")], "b").map((b) => b.localId)).toEqual(["a", "c"]);
  });
});

describe("matchesPromptQuery", () => {
  it("trims and lowercases, matching description OR body", () => {
    expect(matchesPromptQuery({ description: "Radar setup", body: "x" }, "  Ra ")).toBe(true);
    expect(matchesPromptQuery({ description: "Quiet", body: "Launch the RADAR sweep" }, "radar")).toBe(true);
    expect(matchesPromptQuery({ description: "Quiet", body: "nothing" }, "radar")).toBe(false);
  });
  it("an empty or whitespace query matches everything", () => {
    expect(matchesPromptQuery({ description: "x", body: "y" }, "")).toBe(true);
    expect(matchesPromptQuery({ description: "x", body: "y" }, "   ")).toBe(true);
  });
});
