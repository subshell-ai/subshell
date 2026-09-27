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
});
