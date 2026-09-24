import { describe, expect, it } from "bun:test";
import { canAddNode, NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";

/**
 * The rule the Nodes page and the launch picker's empty state both apply.
 *
 * Imported, not restated: both surfaces mirror `POST /api/nodes/setup-keys`'s
 * own gate so neither offers a button the route refuses, and a test that
 * rewrote the expression would pass while the surfaces drifted away from it.
 */
describe("who may add a node", () => {
  it("allows anyone signed in while the setting is on", () => {
    expect(canAddNode({ allowNodeEnrollment: true, viewerIsAdmin: false })).toBe(true);
  });

  it("refuses a non-admin when it is off, and never an admin", () => {
    expect(canAddNode({ allowNodeEnrollment: false, viewerIsAdmin: false })).toBe(false);
    // The switch governs everyone else, the same shape as an admin creating a
    // user while sign-up is closed.
    expect(canAddNode({ allowNodeEnrollment: false, viewerIsAdmin: true })).toBe(true);
  });

  it("treats an UNANSWERED settings read as allowed, not as off", () => {
    // The server's absent row means true, and this has to agree: reading
    // `undefined` as "off" would hide the button from everyone on every load
    // until the request landed, flickering it away and back.
    expect(canAddNode(undefined)).toBe(true);
    expect(canAddNode({})).toBe(true);
  });

  it("states the gate in ONE sentence, shared verbatim by both surfaces", () => {
    // Operator ask 2026-09-24: the Nodes page's disabled-button tooltip says
    // what the launch form says. Both surfaces import this constant, so this
    // pin is what makes "the same copy" an enforced fact rather than a
    // promise about two strings.
    expect(NODE_ENROLLMENT_OFF_COPY).toBe("Adding nodes is turned off on this instance; an admin can add one.");
    // And the copy rules it is written under: ≤2 sentences, no em dash.
    expect(NODE_ENROLLMENT_OFF_COPY).not.toContain("—");
    const sentences = NODE_ENROLLMENT_OFF_COPY.split(/[.!?]\s/).filter((s) => s.trim() !== "");
    expect(sentences.length).toBeLessThanOrEqual(2);
  });
});

describe("the pure rule is not enough on its own", () => {
  it("cannot catch a call site that never asks it", () => {
    // Recorded rather than implied. This file tests `canAddNode` in
    // isolation, and every assertion in it passed while `/nodes` still
    // offered an ungated "Add your first node" button in its empty state —
    // because that call site never called the function. A rule extracted for
    // sharing is only as good as the surfaces that consult it, so the
    // enforceable test is a RENDER test per surface asserting that no
    // add-node affordance exists anywhere on the page. See
    // `nodes-page-gate.test.tsx`.
    expect(canAddNode({ allowNodeEnrollment: false, viewerIsAdmin: false })).toBe(false);
  });
});
