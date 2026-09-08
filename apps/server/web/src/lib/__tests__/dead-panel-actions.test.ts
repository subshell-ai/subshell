import { describe, expect, it } from "bun:test";
import { deadPanelActions } from "@/lib/dead-panel-actions";

// Spec 2026-08-31 §4.1: the terminal's dead panel must enforce the same
// access contract as the actions menu. The deploy-bot incident (2026-09-03)
// was exactly this: an admin (effective `edit`) saw Close on a foreign
// subshell's exited panel and could only 404 with it.
describe("deadPanelActions", () => {
  it("lets the owner both revive and close", () => {
    expect(deadPanelActions("owner")).toEqual({ restart: true, close: true });
  });

  it("gives an edit grantee revive but never Close (delete stays owner-only)", () => {
    expect(deadPanelActions("edit")).toEqual({ restart: true, close: false });
  });

  it("gives a viewer neither button", () => {
    expect(deadPanelActions("view")).toEqual({ restart: false, close: false });
  });

  it("keeps both buttons when no record is loaded (mid-view delete; the backend still gates)", () => {
    expect(deadPanelActions(undefined)).toEqual({ restart: true, close: true });
  });
});
