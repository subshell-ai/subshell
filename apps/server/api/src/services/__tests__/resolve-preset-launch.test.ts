import { describe, expect, it } from "bun:test";
import type { PresetTable } from "@/db/types/presets.db-types.js";
import { resolvePresetLaunch } from "@/services/subshells.service.js";

/**
 * The resolution matrix of spec 2026-09-29 preset-launch-fields, tested in
 * its pure form: request wins, preset fills gaps. `createSubshell` is the one
 * caller for every door (web, mobile, MCP), so pinning this function pins the
 * contract HTTP-level suites would otherwise have to launch machines to reach.
 */
function presetRow(over: Partial<PresetTable> = {}): PresetTable {
  return {
    id: "p1",
    userId: "u1",
    harnessId: "claude-code",
    name: "p",
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    nodeId: null,
    workingDir: null,
    promptBlocks: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...over,
  };
}

const blocks = JSON.stringify([
  { kind: "saved", promptId: "x", description: "A", body: "first" },
  { kind: "custom", description: "", body: "second" },
]);

describe("resolvePresetLaunch", () => {
  it("the request wins for every field a preset also names", () => {
    const r = resolvePresetLaunch(
      { workingDir: "/body", prompt: "body prompt", nodeId: "node-body" },
      presetRow({ workingDir: "/preset", nodeId: "node-preset", promptBlocks: blocks }),
    );
    expect(r).toEqual({ workingDir: "/body", nodeId: "node-body", prompt: "body prompt" });
  });

  it("the preset fills every gap the request left", () => {
    const r = resolvePresetLaunch(
      {},
      presetRow({ workingDir: "/preset", nodeId: "node-preset", promptBlocks: blocks }),
    );
    // Bodies join with ONE blank line, exactly the launch form's rule.
    expect(r).toEqual({ workingDir: "/preset", nodeId: "node-preset", prompt: "first\n\nsecond" });
  });

  it("nothing from either side stays undefined (the caller 400s the dir)", () => {
    expect(resolvePresetLaunch({}, undefined)).toEqual({ workingDir: undefined, nodeId: undefined, prompt: undefined });
    expect(resolvePresetLaunch({}, presetRow())).toEqual({
      workingDir: undefined,
      nodeId: undefined,
      prompt: undefined,
    });
  });

  it("a preset whose node was deleted-then-nulled resolves like one that never named a node", () => {
    // The 0042 FK rule lands here: the column is NULL, so the ladder runs.
    const r = resolvePresetLaunch({ workingDir: "/body" }, presetRow({ nodeId: null, promptBlocks: blocks }));
    expect(r.nodeId).toBeUndefined();
    expect(r.prompt).toBe("first\n\nsecond");
  });

  it("an empty prompt-block stack supplies no prompt (the row says nothing)", () => {
    const r = resolvePresetLaunch({ workingDir: "/body" }, presetRow({ promptBlocks: "[]" }));
    expect(r.prompt).toBeUndefined();
  });
});
