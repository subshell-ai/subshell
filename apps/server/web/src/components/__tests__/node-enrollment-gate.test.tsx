import { describe, expect, it } from "bun:test";
import { canAddNode } from "@/lib/node-enrollment";

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
