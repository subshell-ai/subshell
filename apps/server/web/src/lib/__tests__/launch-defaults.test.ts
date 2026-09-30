import { describe, expect, it } from "bun:test";
import { emptyNewSubshellForm } from "@/components/subshell-picker/launch-form-rules";
import { isUntouchedForm, launchTemplateFromList } from "@/lib/launch-defaults";
import type { SubshellView } from "@/types/subshell";

/**
 * The pure half of "open the launch form with my last settings" (operator
 * rule 2026-09-25): which row is "most recent" (one selector with the agent
 * default), and what disqualifies the auto arm. (The copy picker's listing
 * helpers left with spec 2026-09-29-preset-launch-fields.)
 */

function row(overrides: Partial<SubshellView> & { id: string }): SubshellView {
  return {
    harnessId: "claude-code",
    presetId: null,
    nodeId: "local",
    name: overrides.id,
    workingDir: "/srv/app",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as SubshellView;
}

describe("launchTemplateFromList", () => {
  it("takes the newest row by creation, with the id tie-break", () => {
    const t = launchTemplateFromList([
      row({ id: "a", createdAt: "2026-09-01T00:00:00.000Z", harnessId: "old" }),
      row({ id: "b", createdAt: "2026-09-12T00:00:00.000Z", harnessId: "pi", nodeId: "a1", workingDir: "/x" }),
    ]);
    expect(t).toEqual({ subshellId: "b", harnessId: "pi", presetId: null, nodeId: "a1", workingDir: "/x" });
    // Same millisecond: `sortByCreation`'s total tie-break (id), never input order.
    const tie = launchTemplateFromList([
      row({ id: "z", createdAt: "2026-09-02T00:00:00.000Z" }),
      row({ id: "y", createdAt: "2026-09-02T00:00:00.000Z" }),
    ]);
    expect(tie?.subshellId).toBe("y");
  });

  it("terminated and shared rows are eligible — a finished launch is the usual source", () => {
    const t = launchTemplateFromList([
      row({ id: "own", createdAt: "2026-09-01T00:00:00.000Z", harnessId: "old" }),
      row({
        id: "done",
        createdAt: "2026-09-10T00:00:00.000Z",
        harnessId: "pi",
        status: "terminated",
        alive: false,
        access: "view",
      }),
    ]);
    expect(t?.harnessId).toBe("pi");
  });

  it("coerces the older-payload optional fields to the wire's defaults", () => {
    const t = launchTemplateFromList([
      { id: "r", harnessId: "claude-code", createdAt: "2026-09-01T00:00:00.000Z" } as SubshellView,
    ]);
    expect(t).toEqual({ subshellId: "r", harnessId: "claude-code", presetId: null, nodeId: "local", workingDir: "" });
  });

  it("empty and unanswered lists yield no template", () => {
    expect(launchTemplateFromList([])).toBeNull();
    expect(launchTemplateFromList(undefined)).toBeNull();
    expect(launchTemplateFromList(null)).toBeNull();
  });
});

describe("isUntouchedForm", () => {
  it("is true only for the empty baseline", () => {
    const empty = emptyNewSubshellForm();
    expect(isUntouchedForm({ ...empty }, empty)).toBe(true);
    expect(isUntouchedForm({ ...empty, harnessId: "pi" }, empty)).toBe(false);
    expect(isUntouchedForm({ ...empty, presetId: "p1" }, empty)).toBe(false);
    // The Split case: a caller-supplied pair (harness + dir) is never untouched.
    expect(isUntouchedForm({ ...empty, workingDir: "/x" }, empty)).toBe(false);
    // The re-home case: a node move alone disqualifies the auto arm too.
    expect(isUntouchedForm({ ...empty, nodeId: "a1" }, empty)).toBe(false);
    // The prompt clause (spec 2026-09-28): an opened section, or a block
    // already stacked, is an edit the prior-launch tier must not override.
    expect(isUntouchedForm({ ...empty, promptEnabled: true }, empty)).toBe(false);
    expect(
      isUntouchedForm(
        { ...empty, promptBlocks: [{ localId: "x", kind: "custom", description: "d", body: "b" }] },
        empty,
      ),
    ).toBe(false);
  });
});
