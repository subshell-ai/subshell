import { afterEach, describe, expect, it } from "bun:test";
import { collapsedNodeGroups, setCollapsedNodeGroups, toggleNodeGroup } from "@/lib/sidebar-node-group-pref";

describe("sidebar node-group collapse (per-device preference)", () => {
  const KEY = "subshell.sidebarNodeGroups";
  afterEach(() => localStorage.removeItem(KEY));

  it("defaults to nothing collapsed — a node nobody has touched reads open", () => {
    expect(collapsedNodeGroups()).toEqual([]);
  });

  it("survives a corrupt or hand-edited value instead of throwing on every render", () => {
    localStorage.setItem(KEY, "not json");
    expect(collapsedNodeGroups()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ local: true }));
    expect(collapsedNodeGroups()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify(["local", 7, null, "n1"]));
    expect(collapsedNodeGroups()).toEqual(["local", "n1"]);
  });

  it("persists the set and reads it back", () => {
    expect(setCollapsedNodeGroups(["local"])).toEqual(["local"]);
    expect(collapsedNodeGroups()).toEqual(["local"]);
  });

  it("toggles one id without disturbing the others", () => {
    expect(toggleNodeGroup([], "local")).toEqual(["local"]);
    expect(toggleNodeGroup(["local", "n1"], "local")).toEqual(["n1"]);
    expect(toggleNodeGroup(["n1"], "local")).toEqual(["n1", "local"]);
  });

  it("keys on the node ID, so a rename cannot reopen a group you shut", () => {
    // The label is `node.name` and moves with a rename; this set must not.
    setCollapsedNodeGroups(["n1"]);
    expect(collapsedNodeGroups()).toContain("n1");
  });
});
