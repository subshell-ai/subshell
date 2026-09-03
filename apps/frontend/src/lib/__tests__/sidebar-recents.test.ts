import { describe, expect, it } from "bun:test";
import { recentWorkspaceLinks } from "@/lib/sidebar-recents";
import type { WorkspaceRow } from "@/types/workspace";

/** The sidebar only reads id/name/updatedAt — cast the fixtures. */
const workspace = (id: string, name: string, updatedAt: string): WorkspaceRow =>
  ({ id, name, updatedAt }) as WorkspaceRow;

describe("recentWorkspaceLinks", () => {
  it("re-sorts the alphabetical list by updatedAt, newest first", () => {
    const links = recentWorkspaceLinks([
      workspace("old", "Aardvark", "2026-01-01T00:00:00.000Z"),
      workspace("new", "Zebra", "2026-08-30T00:00:00.000Z"),
      workspace("mid", "Mongoose", "2026-06-15T00:00:00.000Z"),
    ]);
    expect(links.map((l) => l.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps at eight entries without mutating the input", () => {
    const many = Array.from({ length: 9 }, (_, i) => workspace(`w${i}`, `W${i}`, `2026-0${i + 1}-01T00:00:00.000Z`));
    const links = recentWorkspaceLinks(many);
    expect(links).toHaveLength(8);
    expect(links[0]?.id).toBe("w8");
    expect(many.map((w) => w.id)).toEqual(Array.from({ length: 9 }, (_, i) => `w${i}`));
  });

  it("is empty while the list is loading", () => {
    expect(recentWorkspaceLinks(undefined)).toEqual([]);
  });

  it("workspaces carry no path (the row renders one line)", () => {
    const links = recentWorkspaceLinks([workspace("w", "W", "2026-08-30T00:00:00.000Z")]);
    expect(links[0]?.path).toBeUndefined();
  });
});
