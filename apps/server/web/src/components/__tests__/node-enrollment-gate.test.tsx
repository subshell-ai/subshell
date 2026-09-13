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
