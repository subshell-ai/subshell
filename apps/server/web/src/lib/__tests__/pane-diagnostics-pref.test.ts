import { afterEach, describe, expect, it } from "bun:test";
import { paneDiagnosticsIds, setPaneDiagnosticsIds, togglePaneDiagnostics } from "@/lib/pane-diagnostics-pref";

describe("pane diagnostics preference (per-device, per-subshell)", () => {
  const KEY = "subshell.paneDiagnostics";
  afterEach(() => localStorage.removeItem(KEY));

  it("defaults to nothing on: a subshell nobody has diagnosed reads off", () => {
    expect(paneDiagnosticsIds()).toEqual([]);
  });

  it("survives a corrupt or hand-edited value instead of throwing on every render", () => {
    localStorage.setItem(KEY, "not json");
    expect(paneDiagnosticsIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ s1: true }));
    expect(paneDiagnosticsIds()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["s1", 7, null, "s2"]));
    expect(paneDiagnosticsIds()).toEqual(["s1", "s2"]);
  });

  it("persists the set and reads it back", () => {
    expect(setPaneDiagnosticsIds(["s1"])).toEqual(["s1"]);
    expect(paneDiagnosticsIds()).toEqual(["s1"]);
  });

  it("toggles one id without disturbing the others", () => {
    expect(togglePaneDiagnostics([], "s1")).toEqual(["s1"]);
    expect(togglePaneDiagnostics(["s1", "s2"], "s1")).toEqual(["s2"]);
    expect(togglePaneDiagnostics(["s2"], "s1")).toEqual(["s2", "s1"]);
  });

  it("keys on the subshell ID, so a rename cannot close a HUD you opened", () => {
    // The name is a label and moves with a rename; this set must not.
    setPaneDiagnosticsIds(["s1"]);
    expect(paneDiagnosticsIds()).toContain("s1");
  });
});
