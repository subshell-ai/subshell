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

  it("sends the preset id when one is chosen", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", presetId: "pr-9", workingDir: "/tmp/x", name: "n" });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      harnessId: "p1",
      presetId: "pr-9",
      workingDir: "/tmp/x",
      name: "n",
    });
  });

  it("a presetless launch sends NO presetId — null is absence, not a field (spec §2.2)", () => {
    for (const presetId of [null, undefined] as const) {
      const body = toSubshellCreateBody({ harnessId: "p1", presetId, workingDir: "/tmp/x", name: "n" });
      expect(JSON.parse(JSON.stringify(body))).toEqual({ harnessId: "p1", workingDir: "/tmp/x", name: "n" });
    }
  });
});

const block = (id: string): PromptBlock => ({ localId: id, kind: "custom", description: id, body: `b-${id}` });

describe("toSubshellCreateBody prompt (spec 2026-09-28)", () => {
  it("sends no prompt field when the section is off, even with blocks present", () => {
    const body = toSubshellCreateBody({
      harnessId: "p1",
      workingDir: "/x",
      promptEnabled: false,
      promptBlocks: [block("a")],
    });
    expect("prompt" in body).toBe(true);
    expect(body.prompt).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).toEqual({ harnessId: "p1", workingDir: "/x" });
  });

  it("sends no prompt field when the section is on but empty", () => {
    const body = toSubshellCreateBody({ harnessId: "p1", workingDir: "/x", promptEnabled: true, promptBlocks: [] });
    expect(body.prompt).toBeUndefined();
  });

  it("sends the blocks joined by one blank line when on and non-empty", () => {
    const body = toSubshellCreateBody({
      harnessId: "p1",
      workingDir: "/x",
      promptEnabled: true,
      promptBlocks: [block("a"), block("b")],
    });
    expect(body.prompt).toBe(joinPromptBlocks([block("a"), block("b")]));
    expect(body.prompt).toBe("b-a\n\nb-b");
  });
});

describe("promptLaunchMissed (the toast gate the review pinned)", () => {
  it("stays silent for the no-prompt launch the wire also answers false for", () => {
    expect(promptLaunchMissed(false, [], false)).toBe(false);
    expect(promptLaunchMissed(undefined, undefined, false)).toBe(false);
    expect(promptLaunchMissed(true, [], false)).toBe(false);
  });
  it("fires only when a stacked prompt actually missed", () => {
    expect(promptLaunchMissed(true, [block("a")], false)).toBe(true);
    expect(promptLaunchMissed(true, [block("a")], true)).toBe(false);
    expect(promptLaunchMissed(true, [block("a")], undefined)).toBe(false);
  });
});
