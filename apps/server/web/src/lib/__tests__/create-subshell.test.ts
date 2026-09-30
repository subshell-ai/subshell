import { describe, expect, it } from "bun:test";
import { toSubshellCreateBody } from "@/hooks/use-create-subshell";
import { joinPromptBlocks, type PromptBlock, promptLaunchMissed } from "@/lib/prompt-stack";

describe("toSubshellCreateBody", () => {
  it("sends the trimmed name when there is one", () => {
    expect(toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "  deck  " })).toEqual({
      harnessId: "p1",
      workingDir: "/tmp/x",
      name: "deck",
    });
  });

  it("omits the name when blank, so the backend's date/time default applies", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "   " });
    expect(body.name).toBeUndefined();
    expect("name" in body).toBe(true); // the key exists with undefined — JSON.stringify drops it
    expect(JSON.parse(JSON.stringify(body))).toEqual({ harnessId: "p1", workingDir: "/tmp/x" });
  });

  it("omits nodeId entirely when the caller carries none (byte-identical legacy body)", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "n" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({ harnessId: "p1", workingDir: "/tmp/x", name: "n" });
  });

  it("posts a remote pick as-is — remote launch is real (spec §6.6)", () => {
    // The form's node choice reaches the server verbatim; the backend
    // resolves/gates it (404 invisible, 409 NODE_OFFLINE).
    expect(toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "", nodeId: "n1" }).nodeId).toBe("n1");
    const body = toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "n", nodeId: "mac-mini" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      harnessId: "p1",
      workingDir: "/tmp/x",
      name: "n",
      nodeId: "mac-mini",
    });
  });

  it("sends 'local' explicitly — the visible pick is the launch target (spec 2026-09-02 §3)", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "n", nodeId: "local" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      harnessId: "p1",
      workingDir: "/tmp/x",
      name: "n",
      nodeId: "local",
    });
  });

  it("omits nodeId only for an absent/unmade pick", () => {
    // An unmade selection blocks submit upstream (canSubmit), never leaks "".
    expect(toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "" }).nodeId).toBeUndefined();
    expect(
      toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "", nodeId: "" }).nodeId,
    ).toBeUndefined();
  });

  it("sends the preset id when one is chosen, with an empty-string prompt as the explicit none", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", presetId: "pr-9", workingDir: "/tmp/x", name: "n" });
    // spec 2026-09-29-preset-launch-fields: an ABSENT prompt would fall back
    // to the preset's own blocks server-side; a form whose stack is empty is
    // saying "none", which only an explicit "" can carry.
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      harnessId: "p1",
      presetId: "pr-9",
      workingDir: "/tmp/x",
      name: "n",
      prompt: "",
    });
  });

  it("a non-empty stack rides the joined text even with a preset chosen (spec 2026-09-29)", () => {
    const blocks = [
      { localId: "b1", kind: "custom" as const, description: "", body: "first" },
      { localId: "b2", kind: "custom" as const, description: "", body: "second" },
    ];
    const body = toSubshellCreateBody({
      harnessId: "p1",
      presetId: "pr-9",
      workingDir: "/tmp/x",
      name: "n",
      promptBlocks: blocks,
    });
    expect(body.prompt).toBe("first\n\nsecond");
  });

  it("a presetless empty stack still sends NO prompt field (untouched form, no fallback to fear)", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", workingDir: "/tmp/x", name: "n" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({ harnessId: "p1", workingDir: "/tmp/x", name: "n" });
  });

  it("a presetless launch sends NO presetId — null is absence, not a field (spec §2.2)", () => {
    for (const presetId of [null, undefined] as const) {
      const body = toSubshellCreateBody({ harnessId: "p1", presetId, workingDir: "/tmp/x", name: "n" });
      expect(JSON.parse(JSON.stringify(body))).toEqual({ harnessId: "p1", workingDir: "/tmp/x", name: "n" });
    }
  });
});

const block = (id: string): PromptBlock => ({ localId: id, kind: "custom", description: id, body: `b-${id}` });

describe("toSubshellCreateBody prompt (spec 2026-09-28; the checkbox retired 2026-09-30)", () => {
  it("the stack IS the switch: non-empty blocks send the joined text", () => {
    const body = toSubshellCreateBody({
      harnessId: "p1",
      workingDir: "/x",
      promptBlocks: [block("a")],
    });
    expect(body.prompt).toBe("b-a");
  });

  it("sends no prompt field when the stack is empty", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", workingDir: "/x", promptBlocks: [] });
    expect(body.prompt).toBeUndefined();
  });

  it("sends the blocks joined by one blank line when non-empty", () => {
    const body = toSubshellCreateBody({
      harnessId: "p1",
      workingDir: "/x",
      promptBlocks: [block("a"), block("b")],
    });
    expect(body.prompt).toBe(joinPromptBlocks([block("a"), block("b")]));
    expect(body.prompt).toBe("b-a\n\nb-b");
  });
});

describe("promptLaunchMissed (the toast gate the review pinned)", () => {
  it("stays silent for the no-prompt launch the wire also answers false for", () => {
    expect(promptLaunchMissed([], false)).toBe(false);
    expect(promptLaunchMissed(undefined, false)).toBe(false);
  });
  it("fires only when a stacked prompt actually missed", () => {
    expect(promptLaunchMissed([block("a")], false)).toBe(true);
    expect(promptLaunchMissed([block("a")], true)).toBe(false);
    expect(promptLaunchMissed([block("a")], undefined)).toBe(false);
  });
});
