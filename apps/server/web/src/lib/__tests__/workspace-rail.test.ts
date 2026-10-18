import { describe, expect, it } from "bun:test";
import { RECENT_LIMIT } from "@/lib/sidebar-recents";
import { railWorkspaceRows } from "@/lib/workspace-rail";
import type { WorkspaceRow } from "@/types/workspace";

function row(id: string): WorkspaceRow {
  return { id, name: id, layout: null, subshellCount: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "x" };
}

/** Recency-sorted inputs are the contract; newest first. */
const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) => row(`w${i}`));

describe("railWorkspaceRows", () => {
  it("caps the browse view at RECENT_LIMIT", () => {
    expect(railWorkspaceRows(many, { capped: true, activeId: null })).toHaveLength(RECENT_LIMIT);
  });

  it("shows every row when not capped (a search shows all its matches)", () => {
    expect(railWorkspaceRows(many, { capped: false, activeId: "w99" })).toHaveLength(many.length);
  });

  it("keeps an active workspace the cap would age out", () => {
    // The regression (review 2026-10-17): the branch that auto-expands, the
    // one answering "where am I", vanished when its stamp slid past row 8.
    const aged = many[RECENT_LIMIT + 1]!;
    const shown = railWorkspaceRows(many, { capped: true, activeId: aged.id });
    expect(shown.map((w) => w.id)).toContain(aged.id);
    expect(shown).toHaveLength(RECENT_LIMIT + 1);
    // The rows the cap kept hold their places; the active one lands after
    // them, where its own recency puts it.
    expect(shown.slice(0, RECENT_LIMIT).map((w) => w.id)).toEqual(many.slice(0, RECENT_LIMIT).map((w) => w.id));
  });

  it("does not duplicate an active row the cap already holds", () => {
    expect(railWorkspaceRows(many, { capped: true, activeId: many[0]!.id })).toHaveLength(RECENT_LIMIT);
  });

  it("tolerates an active id that is not in the list (a workspace page for a retired row)", () => {
    expect(railWorkspaceRows(many, { capped: true, activeId: "gone" })).toHaveLength(RECENT_LIMIT);
  });
});
