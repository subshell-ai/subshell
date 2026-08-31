import { describe, expect, it } from "bun:test";
import { recentSessionLinks, recentWorkspaceLinks } from "@/lib/sidebar-recents";
import type { SessionView } from "@/types/session";
import type { WorkspaceRow } from "@/types/workspace";

/** The sidebar only reads id/name/updatedAt — cast the fixtures. */
const session = (id: string, name: string): SessionView => ({ id, name }) as SessionView;
const workspace = (id: string, name: string, updatedAt: string): WorkspaceRow =>
  ({ id, name, updatedAt }) as WorkspaceRow;

describe("recentSessionLinks", () => {
  it("takes the first three of the (already newest-first) list", () => {
    const links = recentSessionLinks([session("a", "A"), session("b", "B"), session("c", "C"), session("d", "D")]);
    expect(links).toEqual([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
  });

  it("is empty while the list is loading", () => {
    expect(recentSessionLinks(undefined)).toEqual([]);
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
});
