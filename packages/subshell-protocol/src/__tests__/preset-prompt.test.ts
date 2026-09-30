import { describe, expect, it } from "bun:test";
import {
  isPresetCrossCommReady,
  joinPresetPrompt,
  type PresetPromptBlock,
  parsePresetPromptBlocks,
} from "../preset-prompt.js";

const saved: PresetPromptBlock = { kind: "saved", promptId: "p-1", description: "Standup", body: "Run the standup." };
const stack: PresetPromptBlock = {
  kind: "stack",
  stackId: "s-1",
  stackCount: 3,
  description: "Release flow",
  body: "one\n\ntwo\n\nthree",
};
const custom: PresetPromptBlock = { kind: "custom", description: "", body: "freely typed" };

describe("joinPresetPrompt", () => {
  it("joins bodies with ONE blank line - byte-identical to the launch form's join", () => {
    expect(joinPresetPrompt([saved, custom])).toBe("Run the standup.\n\nfreely typed");
  });

  it("passes a stack block's internal blank lines through untouched", () => {
    // The member count came from the pick; the text may lawfully contain the
    // join sequence, and the join never re-splits it.
    expect(joinPresetPrompt([stack, custom])).toBe("one\n\ntwo\n\nthree\n\nfreely typed");
  });

  it("joins the empty stack to the empty string", () => {
    expect(joinPresetPrompt([])).toBe("");
  });
});

describe("parsePresetPromptBlocks", () => {
  it("round-trips a valid array", () => {
    const json = JSON.stringify([saved, stack, custom]);
    expect(parsePresetPromptBlocks(json)).toEqual([saved, stack, custom]);
  });

  it("maps null and empty-string columns to null (the row carries no prompt)", () => {
    expect(parsePresetPromptBlocks(null)).toBeNull();
    expect(parsePresetPromptBlocks(undefined)).toBeNull();
    expect(parsePresetPromptBlocks("")).toBeNull();
  });

  it("refuses malformed stored JSON with bad_preset_prompt", () => {
    for (const bad of ["not json", "42", '{"kind":"custom"}', "[1]", "[null]", '[{"kind":"nope","body":"x"}]']) {
      expect(() => parsePresetPromptBlocks(bad)).toThrow("bad_preset_prompt");
    }
  });

  it("refuses members missing body or description", () => {
    expect(() => parsePresetPromptBlocks('[{"kind":"custom","description":"x"}]')).toThrow("bad_preset_prompt");
    expect(() => parsePresetPromptBlocks('[{"kind":"custom","body":"x"}]')).toThrow("bad_preset_prompt");
  });
});

describe("isPresetCrossCommReady", () => {
  const filled = { nodeId: "node-1", workingDir: "/srv/app", promptBlocks: JSON.stringify([saved]) };

  it("is true only when node, dir, and a non-empty prompt are all set", () => {
    expect(isPresetCrossCommReady(filled)).toBe(true);
  });

  it("is false when any one of the three is missing", () => {
    expect(isPresetCrossCommReady({ ...filled, nodeId: null })).toBe(false);
    expect(isPresetCrossCommReady({ ...filled, workingDir: null })).toBe(false);
    expect(isPresetCrossCommReady({ ...filled, promptBlocks: null })).toBe(false);
    expect(isPresetCrossCommReady({ ...filled, promptBlocks: "[]" })).toBe(false);
  });

  it("is false for an all-NULL row (the ordinary settings-only preset)", () => {
    expect(isPresetCrossCommReady({ nodeId: null, workingDir: null, promptBlocks: null })).toBe(false);
  });
});
