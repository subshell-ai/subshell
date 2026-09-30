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
  const filled = { crossCommEnabled: 1, nodeId: "node-1", workingDir: "/srv/app" };

  it("is true when the switch is ON and a machine and a directory are set", () => {
    expect(isPresetCrossCommReady(filled)).toBe(true);
    expect(isPresetCrossCommReady({ ...filled, crossCommEnabled: true })).toBe(true);
    // Opt-in (migration 0043): a ready preset nobody switched on promises nothing.
    expect(isPresetCrossCommReady({ ...filled, crossCommEnabled: 0 })).toBe(false);
  });

  it("the prompt is NOT a requirement (re-ruling 2026-09-30)", () => {
    // Machine + directory + the switch is ready even with nothing to type;
    // a preset that says WHERE still launches by name.
    expect(isPresetCrossCommReady(filled)).toBe(true);
  });

  it("is false when either launch field is missing", () => {
    expect(isPresetCrossCommReady({ ...filled, nodeId: null })).toBe(false);
    expect(isPresetCrossCommReady({ ...filled, workingDir: null })).toBe(false);
    expect(isPresetCrossCommReady({ crossCommEnabled: 1, nodeId: null, workingDir: null })).toBe(false);
  });
});
