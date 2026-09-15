import { describe, expect, it } from "bun:test";
import { isSelectable, nodePickSettled, nodeRunsHarness, pickNodeDefault } from "@/lib/node-pick";
import type { Node } from "@/types/node";

/** Minimal Node factory — the decision reads id/name/status and `canLaunch`. */
function make(over: Partial<Node> = {}): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    status: "online",
    access: "owner",
    // The launchable default: cases about a node that cannot be picked pass
    // `canLaunch: false` explicitly, which is what makes them read as the
    // exception they are.
    canLaunch: true,
    agentVersion: null,
    protocolVersion: null,
    ...over,
  };
}

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

describe("nodePickSettled", () => {
  const LOCAL = make({ id: "local", name: "control plane", kind: "local" });
  const A1 = make({ id: "a1", name: "mac mini" });

  it("an unanswered list is settled — the pick cannot move yet", () => {
    // A pre-nodes instance 404s the route and `data` stays undefined forever;
    // gating on it would leave the agent default permanently unarmed.
    expect(nodePickSettled(undefined, "local")).toBe(true);
  });

  it("a pick the list keeps is settled", () => {
    expect(nodePickSettled([LOCAL, A1], "local")).toBe(true);
  });

  it("a pick the re-home is about to MOVE is not settled", () => {
    // The exact shape of the bug: `local` visible but unlaunchable, one agent
    // node left. Reading the agent inventory now would read the WRONG node's,
    // and the resulting harnessId would stick through the re-home.
    const unlaunchable = make({ id: "local", kind: "local", canLaunch: false });
    expect(pickNodeDefault([unlaunchable, A1], "local")).toBe("a1");
    expect(nodePickSettled([unlaunchable, A1], "local")).toBe(false);
  });

  it("a pick the re-home is about to CLEAR is not settled either", () => {
    expect(nodePickSettled([make({ id: "a9" }), A1], "local")).toBe(false);
  });

  it('NO pick ("") is never settled, though it is a fixed point of pickNodeDefault', () => {
    // The trap: `pickNodeDefault(nodes, "") === ""` when several nodes are
    // selectable, so an equality-only gate would call "no node at all"
    // settled. `installedOnNode` then finds no row, reads every agent as
    // unknown-and-usable, and the default fills from an inventory belonging
    // to nothing — greyed-but-selected by another road.
    const two = [make({ id: "a1" }), make({ id: "a9" })];
    expect(pickNodeDefault(two, "")).toBe("");
    expect(nodePickSettled(two, "")).toBe(false);
  });
});

describe("nodeRunsHarness", () => {
  const withHarnesses = (installed: boolean) =>
    make({ id: "a1", harnesses: [{ harnessId: "claude-code", name: "Claude Code", installed }] });

  it("no agent chosen blocks nothing — there is nothing to fail against", () => {
    expect(nodeRunsHarness(withHarnesses(false), null)).toBe(true);
  });

  it("a node with NO inventory blocks nothing (older server: unknown is not a refusal)", () => {
    expect(nodeRunsHarness(make({ id: "a1" }), "claude-code")).toBe(true);
  });

  it("an entry that exists and is installed fits; one that is not installed does not", () => {
    expect(nodeRunsHarness(withHarnesses(true), "claude-code")).toBe(true);
    expect(nodeRunsHarness(withHarnesses(false), "claude-code")).toBe(false);
  });

  it("an agent absent from a declared inventory does not fit", () => {
    // The node reported its set; this plugin is not in it. That is a real
    // "no", unlike the missing-inventory case above.
    expect(nodeRunsHarness(withHarnesses(true), "codex")).toBe(false);
  });
});
