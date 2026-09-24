import { describe, expect, it } from "bun:test";
import { launchGuidance, serverSubshellsOn } from "@/lib/launch-guidance";

/**
 * The Subshells page's "nothing can launch" guidance (operator ask,
 * 2026-09-24): shown when the Server is switched off as a node AND no agent
 * machine exists, with the copy branching on whether THIS viewer may fix it.
 * Pure, like the enrollment rule it borrows — the route composes the three
 * facts; this decides what the page says.
 */
describe("serverSubshellsOn", () => {
  it("reads absent as ON, like the server's absent row and the enrollment unknown case", () => {
    // An older server sends no field; a payload in flight is empty. Reading
    // either as OFF would flash the guidance away and back on every load,
    // which is the exact mistake `node-enrollment.ts` documents.
    expect(serverSubshellsOn(undefined)).toBe(true);
    expect(serverSubshellsOn({})).toBe(true);
    expect(serverSubshellsOn({ allowServerSubshells: true })).toBe(true);
    expect(serverSubshellsOn({ allowServerSubshells: false })).toBe(false);
  });
});

describe("launchGuidance", () => {
  const off = { allowServerSubshells: false as const };

  it("stays silent while the nodes read has not answered", () => {
    // Guidance that appears and then retracts when a slow read lands is
    // worse than a beat of the ordinary empty state.
    expect(launchGuidance({ nodesLoaded: false, agentNodeCount: 0, settings: off, canAdd: true })).toBeNull();
  });

  it("stays silent while the Server is a node, however few machines exist", () => {
    expect(launchGuidance({ nodesLoaded: true, agentNodeCount: 0, settings: {}, canAdd: true })).toBeNull();
  });

  it("stays silent when an agent node exists, even an unreachable one", () => {
    // The rows answer for themselves (offline dots, the launch form's
    // per-machine reasons); this card is about the ABSENCE of any target.
    expect(launchGuidance({ nodesLoaded: true, agentNodeCount: 1, settings: off, canAdd: true })).toBeNull();
  });

  it("points the fixer at the Nodes page when they can act", () => {
    const g = launchGuidance({ nodesLoaded: true, agentNodeCount: 0, settings: off, canAdd: true });
    expect(g).not.toBeNull();
    expect(g?.actionTo).toBe("/nodes");
    expect(g?.description).toMatch(/[Aa]dd/);
    expect(g?.description).not.toMatch(/ask an admin/i);
  });

  it("names an admin when the viewer cannot mint a setup key", () => {
    const g = launchGuidance({ nodesLoaded: true, agentNodeCount: 0, settings: off, canAdd: false });
    expect(g).not.toBeNull();
    // Operator wording 2026-09-24: the situation, then the one ask — no
    // narration of enrollment settings the viewer cannot see or change.
    expect(g?.description).toBe(
      "There are no nodes available that can start subshells. Contact your admin to add a node.",
    );
    // The button still goes somewhere real for this viewer too.
    expect(g?.actionTo).toBe("/nodes");
  });

  it("keeps the copy rule: at most two sentences, no em dashes", () => {
    for (const canAdd of [true, false]) {
      const g = launchGuidance({ nodesLoaded: true, agentNodeCount: 0, settings: off, canAdd });
      // Operator wording 2026-09-24: one headline for both branches.
      expect(g?.headline).toBe("There are no nodes available");
      expect(g?.description).not.toContain("—");
      const sentences = (g?.description ?? "").split(/[.!?]\s/).filter((s) => s.trim() !== "");
      expect(sentences.length).toBeLessThanOrEqual(2);
    }
  });
});
