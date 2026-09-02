import { describe, expect, it } from "bun:test";
import { anchorDecision, isSelectable, pickNodeDefault } from "@/lib/node-anchor";
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

describe("isSelectable", () => {
  it("Local is always pickable; an agent only while online", () => {
    expect(isSelectable(make({ id: "local", kind: "local", status: "offline" }))).toBe(true);
    expect(isSelectable(make({ id: "a1", kind: "agent", status: "online" }))).toBe(true);
    expect(isSelectable(make({ id: "a2", kind: "agent", status: "offline" }))).toBe(false);
  });
});

describe("pickNodeDefault", () => {
  const LOCAL = make({ id: "local", name: "control plane", kind: "local" });
  const A1 = make({ id: "a1", name: "mac mini" });
  const A2 = make({ id: "a2", name: "old laptop", status: "offline" });

  it("keeps the current pick while it stays in the list and selectable", () => {
    expect(pickNodeDefault([LOCAL, A1, A2], "local")).toBe("local");
    expect(pickNodeDefault([LOCAL, A1, A2], "a1")).toBe("a1");
  });

  it("vanished pick with exactly one selectable left → auto-pick it", () => {
    // Admin turned off Local launching: `local` is gone, one agent remains.
    expect(pickNodeDefault([A1], "local")).toBe("a1");
  });

  it('vanished pick with several selectable left → "" — an explicit choice is due', () => {
    expect(pickNodeDefault([A1, make({ id: "a9", name: "studio" })], "local")).toBe("");
  });

  it("present-but-offline pick falls through like a vanished one", () => {
    // Only the dead agent was selectable-once… now nothing else picks for you.
    expect(pickNodeDefault([LOCAL, A1, A2], "a2")).toBe("");
    // …but with exactly one live option left it is auto-picked.
    expect(pickNodeDefault([A1, A2], "a2")).toBe("a1");
  });

  it('empty list → "" (web parity: a loaded-but-empty registry is no target)', () => {
    expect(pickNodeDefault([], "local")).toBe("");
  });
});
