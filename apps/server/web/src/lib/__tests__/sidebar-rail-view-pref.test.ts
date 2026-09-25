import { afterEach, describe, expect, it } from "bun:test";
import { RAIL_SUBSHELLS_VIEWS, railSubshellsView, setRailSubshellsView } from "@/lib/sidebar-rail-view-pref";

/**
 * The rail's subshell rendering mode is a per-DEVICE preference (same tier as
 * the group-collapse set): which shape you want the list in is a property of
 * the screen you are at, not of the account. What is pinned here is exactly
 * what the collapse pref pins — absent storage answers the default, a corrupt
 * or hand-edited value answers it too rather than throwing on every render,
 * and every real mode round-trips.
 */

const KEY = "subshell.sidebarRailView";

afterEach(() => localStorage.removeItem(KEY));

describe("rail subshells view (per-device preference)", () => {
  it("defaults to rows — the shape the rail has always had", () => {
    expect(railSubshellsView()).toBe("rows");
  });

  it("persists and reads back each mode", () => {
    for (const view of RAIL_SUBSHELLS_VIEWS) {
      expect(setRailSubshellsView(view)).toBe(view);
      expect(railSubshellsView()).toBe(view);
    }
  });

  it("falls back to rows on a corrupt or unknown stored value", () => {
    localStorage.setItem(KEY, "not json either");
    expect(railSubshellsView()).toBe("rows");
    localStorage.setItem(KEY, "grid");
    expect(railSubshellsView()).toBe("rows");
  });

  it("exposes the runtime list so a writer and the type cannot drift", () => {
    expect(RAIL_SUBSHELLS_VIEWS).toEqual(["rows", "cells", "cells-flat"]);
  });
});
