import { describe, expect, it } from "bun:test";
import { recentSubshellLinks, recentWorkspaceLinks } from "@/lib/sidebar-recents";
import type { SubshellView } from "@/types/subshell";
import type { WorkspaceRow } from "@/types/workspace";

/** The sidebar only reads id/name/workingDir/updatedAt — cast the fixtures. */
const subshell = (id: string, name: string, workingDir = `/home/theo/${id}`): SubshellView =>
  ({ id, name, workingDir }) as SubshellView;
const workspace = (id: string, name: string, updatedAt: string): WorkspaceRow =>
  ({ id, name, updatedAt }) as WorkspaceRow;

describe("recentSubshellLinks", () => {
  it("takes the first three of the (already newest-first) list, with the working dir", () => {
    const links = recentSubshellLinks([subshell("a", "A"), subshell("b", "B"), subshell("c", "C"), subshell("d", "D")]);
    expect(links).toEqual([
      { id: "a", label: "A", path: "/home/theo/a" },
      { id: "b", label: "B", path: "/home/theo/b" },
      { id: "c", label: "C", path: "/home/theo/c" },
    ]);
  });

  it("is empty while the list is loading", () => {
    expect(recentSubshellLinks(undefined)).toEqual([]);
  });
});

describe("recentWorkspaceLinks", () => {
  it("re-sorts the alphabetical list by updatedAt, newest first", () => {
    const links = recentWorkspaceLinks([
      workspace("old", "Aardvark", "2026-01-01T00:00:00.000Z"),
      workspace("new", "Zebra", "2026-08-30T00:00:00.000Z"),
      workspace("mid", "Mongoose", "2026-06-15T00:00:00.000Z"),
    ]);
    expect(links.map((l) => l.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps at three entries without mutating the input", () => {
    const four = [
      workspace("a", "A", "2026-01-01T00:00:00.000Z"),
      workspace("b", "B", "2026-02-01T00:00:00.000Z"),
      workspace("c", "C", "2026-03-01T00:00:00.000Z"),
      workspace("d", "D", "2026-04-01T00:00:00.000Z"),
    ];
    expect(recentWorkspaceLinks(four).map((l) => l.id)).toEqual(["d", "c", "b"]);
    expect(four.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is empty while the list is loading", () => {
    expect(recentWorkspaceLinks(undefined)).toEqual([]);
  });

  it("workspaces carry no path (the row renders one line)", () => {
    const links = recentWorkspaceLinks([workspace("w", "W", "2026-08-30T00:00:00.000Z")]);
    expect(links[0]?.path).toBeUndefined();
  });
});
