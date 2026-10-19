import { describe, expect, it } from "bun:test";
import { sidebarSection, sidebarWorkspace } from "@/lib/sidebar-context";
import type { WorkspaceRow } from "@/types/workspace";

const rows = [
  { id: "a", updatedAt: "2026-10-17", panes: [{ subshellId: "shared" }] },
  { id: "b", updatedAt: "2026-10-18", panes: [{ subshellId: "shared" }, { subshellId: "only-b" }] },
] as WorkspaceRow[];
describe("sidebar context", () => {
  it("distinguishes browsing from workspace and subshell detail", () => {
    expect(sidebarSection("/workspaces")).toBe("workspaces");
    expect(sidebarSection("/subshells")).toBe("subshells");
    expect(sidebarSection("/workspaces/a")).toBe("workspaces");
    expect(sidebarSection("/subshells/s1")).toBe("workspaces");
    expect(sidebarSection("/nodes/local")).toBe("settings");
    expect(sidebarSection("/settings/logs")).toBe("settings");
    expect(sidebarSection("/preferences")).toBe("account");
    expect(sidebarSection("/mobile")).toBe("mobile");
  });
  it("uses the URL before the last workspace and refuses a missing URL target", () => {
    expect(sidebarWorkspace(rows, "/workspaces/a", "b")?.id).toBe("a");
    expect(sidebarWorkspace(rows, "/workspaces/deleted", "b")).toBeUndefined();
  });
  it("selects only a workspace holding a directly visited subshell", () => {
    expect(sidebarWorkspace(rows, "/subshells/only-b", "a")?.id).toBe("b");
    expect(sidebarWorkspace(rows, "/subshells/shared", "a")?.id).toBe("a");
    expect(sidebarWorkspace(rows, "/subshells/unfiled", "a")).toBeUndefined();
  });
  it("falls back to recency after the last workspace retires", () => {
    expect(sidebarWorkspace(rows, "/", "deleted")?.id).toBe("b");
    expect(sidebarWorkspace([], "/", null)).toBeUndefined();
  });
});
