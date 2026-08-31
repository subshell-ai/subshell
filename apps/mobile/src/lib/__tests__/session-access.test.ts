import { describe, expect, it } from "bun:test";
import { sessionActionFlags } from "@/lib/session-access";

/** The mobile action bar + live-input gate, derived from viewer access (§4.1). */
describe("sessionActionFlags", () => {
  it("view: no action bar, read-only input", () => {
    expect(sessionActionFlags("view")).toEqual({ showActions: false, canEdit: false, isOwner: false, canInput: false });
  });

  it("edit: actions and input, but not owner-only ones", () => {
    expect(sessionActionFlags("edit")).toEqual({ showActions: true, canEdit: true, isOwner: false, canInput: true });
  });

  it("owner: everything", () => {
    expect(sessionActionFlags("owner")).toEqual({ showActions: true, canEdit: true, isOwner: true, canInput: true });
  });

  it("undefined (still loading) is treated as the most restrictive state", () => {
    expect(sessionActionFlags(undefined).showActions).toBe(false);
    expect(sessionActionFlags(undefined).canInput).toBe(false);
  });
});
