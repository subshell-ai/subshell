import { describe, expect, it } from "bun:test";
import { subshellActionFlags } from "@/lib/subshell-access";

/** The mobile action bar + live-input gate, derived from viewer access (§4.1). */
describe("subshellActionFlags", () => {
  it("view: no action bar, read-only input", () => {
    expect(subshellActionFlags("view")).toEqual({
      showActions: false,
      canEdit: false,
      isOwner: false,
      canInput: false,
    });
  });

  it("edit: actions and input, but not owner-only ones", () => {
    expect(subshellActionFlags("edit")).toEqual({ showActions: true, canEdit: true, isOwner: false, canInput: true });
  });

  it("owner: everything", () => {
    expect(subshellActionFlags("owner")).toEqual({ showActions: true, canEdit: true, isOwner: true, canInput: true });
  });

  it("undefined (still loading) is treated as the most restrictive state", () => {
    expect(subshellActionFlags(undefined).showActions).toBe(false);
    expect(subshellActionFlags(undefined).canInput).toBe(false);
  });
});
