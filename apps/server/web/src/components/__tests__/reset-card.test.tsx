import { describe, expect, it } from "bun:test";
import { resetCardVisible } from "../settings/reset-card";

describe("resetCardVisible", () => {
  it("shows for an admin inside the desktop shell, and nowhere else", () => {
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: true })).toBe(true);
    expect(resetCardVisible({ viewerIsAdmin: false, desktop: true })).toBe(false);
    expect(resetCardVisible({ viewerIsAdmin: undefined, desktop: true })).toBe(false);
    // A plain browser, or Subshell Client (marker stripped): the reset verb
    // lives in the SERVER app's console, so an entry with no path to it
    // would be a button that lies.
    expect(resetCardVisible({ viewerIsAdmin: true, desktop: false })).toBe(false);
  });
});
