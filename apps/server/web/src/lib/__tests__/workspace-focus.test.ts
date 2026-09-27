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

  it("routes a focus request to its subscribers until they unsubscribe", () => {
    const seen: string[] = [];
    const unsub = onWorkspacePaneFocusRequest((id) => seen.push(id));
    requestWorkspacePaneFocus("p1");
    expect(seen).toEqual(["p1"]);
    unsub();
    // A released subscriber stops hearing requests; the dock is the only
    // consumer, so this is the rail→dock command in miniature.
    requestWorkspacePaneFocus("p2");
    expect(seen).toEqual(["p1"]);
  });
});
