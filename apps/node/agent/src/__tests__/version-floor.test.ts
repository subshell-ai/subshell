import { describe, expect, it } from "bun:test";
import { MIN_NODE_VERSION, nodeVersionSupported } from "@internal/subshell-protocol";
import { NODE_VERSION } from "../version.js";

/**
 * This agent must satisfy the floor its own control plane enforces.
 *
 * The two live in different packages — `MIN_NODE_VERSION` in
 * `@internal/subshell-protocol`, `NODE_VERSION` in this app's package.json —
 * so raising the floor without raising the version is silent: everything
 * compiles and every other test passes. The failure appears only as a node
 * built from HEAD being closed with NODE_CLOSE_UPDATE_REQUIRED by a server
 * built from the same commit, with no agent in existence that satisfies its
 * own server until the version PR lands.
 *
 * Caught in review on 2026-09-05, when the directory-allowlist protocol bump
 * raised the floor to 0.4.0 and left this package at 0.3.1.
 */
describe("agent version floor", () => {
  it("this agent satisfies the control plane's minimum", () => {
    // Asserted as a pair so the failure names both numbers — a bare
    // `false !== true` would not say which of the two to change.
    expect({ agent: NODE_VERSION, satisfiesFloor: nodeVersionSupported(NODE_VERSION) }).toEqual({
      agent: NODE_VERSION,
      satisfiesFloor: true,
    });
    expect(MIN_NODE_VERSION.length).toBeGreaterThan(0);
  });
});
