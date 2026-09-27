import { afterEach, describe, expect, it } from "bun:test";
import { paneCopyModeIds, setPaneCopyModeIds, togglePaneCopyMode } from "@/lib/pane-copy-mode-pref";

describe("pane copy-mode preference (per-device, per-subshell)", () => {
  const KEY = "subshell.paneCopyMode";
  afterEach(() => localStorage.removeItem(KEY));

  it("defaults to off: a subshell nobody put into copy mode reads off", () => {
    expect(paneCopyModeIds()).toEqual([]);
  });

  it("survives a corrupt or hand-edited value instead of throwing on every render", () => {
    localStorage.setItem(KEY, "not json");
    expect(paneCopyModeIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ s1: true }));
    expect(paneCopyModeIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["s1", 7, null, "s2"]));
    expect(paneCopyModeIds()).toEqual(["s1", "s2"]);
  });

  it("persists the set and reads it back", () => {
    expect(setPaneCopyModeIds(["s1"])).toEqual(["s1"]);
    expect(paneCopyModeIds()).toEqual(["s1"]);
  });

  it("toggles one id without disturbing the others", () => {
    expect(togglePaneCopyMode([], "s1")).toEqual(["s1"]);
    expect(togglePaneCopyMode(["s1", "s2"], "s1")).toEqual(["s2"]);
    expect(togglePaneCopyMode(["s2"], "s1")).toEqual(["s2", "s1"]);
  });

  it("keys on the subshell ID, so a rename cannot drop you out of copy mode", () => {
    // The name is a label and moves with a rename; this set must not.
    setPaneCopyModeIds(["s1"]);
    expect(paneCopyModeIds()).toContain("s1");
  });

  it("lives under its OWN key: a diagnostics HUD and a copy mode are two choices", () => {
    // Regression guard against a copy-paste of the diagnostics key.
    localStorage.setItem("subshell.paneDiagnostics", JSON.stringify(["s1"]));
    expect(paneCopyModeIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["s2"]));
    expect(paneCopyModeIds()).toEqual(["s2"]);
  });
});
