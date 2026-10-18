import { afterEach, describe, expect, it } from "bun:test";
import {
  getWorkspaceFocusedId,
  onWorkspacePaneFocusRequest,
  requestWorkspacePaneFocus,
  resetWorkspaceFocusForTests,
  setWorkspaceFocusedId,
} from "@/lib/workspace-focus";

describe("workspace-focus store", () => {
  afterEach(() => resetWorkspaceFocusForTests());

  it("holds the dock's focused pane id", () => {
    expect(getWorkspaceFocusedId()).toBeNull();
    setWorkspaceFocusedId("a");
    expect(getWorkspaceFocusedId()).toBe("a");
    setWorkspaceFocusedId(null);
    expect(getWorkspaceFocusedId()).toBeNull();
  });

  it("reports whether a focus request was handled, until the subscriber releases", () => {
    const seen: string[] = [];
    const unsub = onWorkspacePaneFocusRequest((id) => {
      seen.push(id);
      return id === "p1"; // only handles p1; an unknown pane reports unhandled
    });
    expect(requestWorkspacePaneFocus("p1")).toBe(true);
    // Unhandled → the caller lets the link navigate instead of dead-clicking.
    expect(requestWorkspacePaneFocus("p2")).toBe(false);
    expect(seen).toEqual(["p1", "p2"]);
    unsub();
    // No subscriber left → nothing handles it → the click navigates.
    expect(requestWorkspacePaneFocus("p3")).toBe(false);
    expect(seen).toEqual(["p1", "p2"]);
  });

  it("carries the branch scope, and a handler refuses a workspace it does not own", () => {
    // The dock's real shape: it holds p1, and it stands on w1. A sidebar
    // branch click on w1's row focuses it; the SAME pane clicked inside w2's
    // branch must NOT be answered here (review 2026-10-17: it used to light
    // up w1's tab while the click meant "go to w2").
    const scopes: (string | undefined)[] = [];
    const unsub = onWorkspacePaneFocusRequest((id, workspaceId) => {
      scopes.push(workspaceId);
      if (workspaceId !== undefined && workspaceId !== "w1") return false;
      return id === "p1";
    });
    expect(requestWorkspacePaneFocus("p1", "w2")).toBe(false);
    expect(requestWorkspacePaneFocus("p1", "w1")).toBe(true);
    // Unscoped (a list row's click): "wherever its tab is" — the dock answers.
    expect(requestWorkspacePaneFocus("p1")).toBe(true);
    expect(scopes).toEqual(["w2", "w1", undefined]);
    unsub();
  });
});
