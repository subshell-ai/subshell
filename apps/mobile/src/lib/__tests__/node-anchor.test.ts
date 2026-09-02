import { describe, expect, it } from "bun:test";
import { anchorDecision } from "@/lib/node-anchor";
import type { Node } from "@/types/node";

/** Minimal Node factory — the decision only reads id/name/status. */
function make(over: Partial<Node> = {}): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    status: "online",
    access: "owner",
    agentVersion: null,
    protocolVersion: null,
    ...over,
  };
}

const PINNED = make({ id: "a1", name: "mac mini" });

describe("anchorDecision", () => {
  it("anchors to the pinned node while the user stays silent", () => {
    expect(anchorDecision({ pinRow: PINNED, explicit: false, current: "local", anchoredTo: null })).toEqual({
      nodeId: "a1",
      anchoredTo: "a1",
    });
  });

  it("an explicit pick — Local included — outranks the anchor", () => {
    expect(anchorDecision({ pinRow: PINNED, explicit: true, current: "local", anchoredTo: "a1" })).toEqual({
      nodeId: "local",
      anchoredTo: "a1",
    });
  });

  it("releases an unearned anchor back to local, only while it still owns the pick", () => {
    expect(anchorDecision({ pinRow: null, explicit: false, current: "a1", anchoredTo: "a1" }).nodeId).toBe("local");
    // The user's own pick, or already elsewhere: nothing to release.
    expect(anchorDecision({ pinRow: null, explicit: true, current: "a1", anchoredTo: "a1" }).nodeId).toBe("a1");
    expect(anchorDecision({ pinRow: null, explicit: false, current: "local", anchoredTo: "a1" }).nodeId).toBe("local");
  });

  it("an offline pinned row anchors unchanged — selected-but-offline is the honest target", () => {
    const offline = make({ id: "a2", name: "old laptop", status: "offline" });
    expect(anchorDecision({ pinRow: offline, explicit: false, current: "local", anchoredTo: null }).nodeId).toBe("a2");
  });
});
