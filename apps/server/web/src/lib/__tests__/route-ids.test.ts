import { describe, expect, it } from "bun:test";
import { isDetailPath, subshellIdFromPath, workspaceIdFromPath } from "@/lib/route-ids";

describe("workspaceIdFromPath", () => {
  it("reads the detail segment on the page it names", () => {
    expect(workspaceIdFromPath("/workspaces/w1")).toBe("w1");
  });

  it("reads the first segment even when the route would not match further", () => {
    // No such page today, but the parse must say WHICH segment it took.
    expect(workspaceIdFromPath("/workspaces/w1/rename")).toBe("w1");
  });

  it("is null on the bare list, the prefix with no id, and near-misses", () => {
    expect(workspaceIdFromPath("/workspaces")).toBeNull();
    expect(workspaceIdFromPath("/workspaces/")).toBeNull();
    expect(workspaceIdFromPath("/workspacesx/w1")).toBeNull();
    expect(workspaceIdFromPath("/Workspaces/w1")).toBeNull();
    expect(workspaceIdFromPath("/")).toBeNull();
  });
});

describe("subshellIdFromPath", () => {
  it("reads the detail segment, and null everywhere else", () => {
    expect(subshellIdFromPath("/subshells/s1")).toBe("s1");
    expect(subshellIdFromPath("/subshells/")).toBeNull();
    expect(subshellIdFromPath("/workspaces/w1")).toBeNull();
  });

  it("the two parsers never answer for each other's page", () => {
    expect(workspaceIdFromPath("/subshells/s1")).toBeNull();
    expect(subshellIdFromPath("/workspaces/w1")).toBeNull();
  });
});

describe("isDetailPath", () => {
  it("is true on either detail page, false on every list or near-miss", () => {
    expect(isDetailPath("/subshells/s1")).toBe(true);
    expect(isDetailPath("/workspaces/w1")).toBe(true);
    expect(isDetailPath("/subshells/")).toBe(false);
    expect(isDetailPath("/workspaces")).toBe(false);
    expect(isDetailPath("/")).toBe(false);
    expect(isDetailPath("/nodes")).toBe(false);
  });
});
