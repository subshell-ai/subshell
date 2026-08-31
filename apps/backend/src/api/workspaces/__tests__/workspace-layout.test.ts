import { describe, expect, it } from "bun:test";
import { panelIdsInLayout, pruneLayout } from "@/api/workspaces/workspace-layout.js";

/** A two-pane layout: one leaf with both panels side by side. */
function twoPaneLayout() {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          { type: "leaf", data: { views: ["a"], activeView: "a" }, size: 500 },
          { type: "leaf", data: { views: ["b"], activeView: "b" }, size: 500 },
        ],
      },
      width: 1000,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: { a: { id: "a" }, b: { id: "b" } },
    activeGroup: "1",
  };
}

describe("panelIdsInLayout", () => {
  it("lists every panel id", () => {
    expect(panelIdsInLayout(twoPaneLayout()).sort()).toEqual(["a", "b"]);
  });

  it("returns nothing for a null or malformed layout", () => {
    expect(panelIdsInLayout(null)).toEqual([]);
    expect(panelIdsInLayout({ nonsense: true })).toEqual([]);
    expect(panelIdsInLayout("not an object")).toEqual([]);
  });
});

describe("pruneLayout", () => {
  it("leaves a layout alone when every panel still has a pane", () => {
    const layout = twoPaneLayout();
    expect(pruneLayout(layout, new Set(["a", "b"]))).toEqual(layout);
  });

  it("drops a panel whose pane row is gone, and its now-empty leaf", () => {
    const pruned = pruneLayout(twoPaneLayout(), new Set(["a"]));
    expect(panelIdsInLayout(pruned)).toEqual(["a"]);
    expect(pruned?.panels).toEqual({ a: { id: "a" } });
    // The leaf holding "b" is removed rather than left empty.
    const root = (pruned as any).grid.root;
    expect(root.data).toHaveLength(1);
  });

  it("returns null when every panel is gone", () => {
    expect(pruneLayout(twoPaneLayout(), new Set())).toBeNull();
  });

  it("keeps a multi-view leaf and only removes the dead view", () => {
    const layout = {
      grid: {
        root: { type: "branch", data: [{ type: "leaf", data: { views: ["a", "b"], activeView: "b" }, size: 1000 }] },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { a: { id: "a" }, b: { id: "b" } },
    };
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    expect(pruned.grid.root.data[0].data.views).toEqual(["a"]);
    // activeView pointed at the removed panel and must be repaired.
    expect(pruned.grid.root.data[0].data.activeView).toBe("a");
  });

  it("returns null for a malformed layout rather than throwing", () => {
    expect(pruneLayout("garbage", new Set(["a"]))).toBeNull();
    expect(pruneLayout(null, new Set(["a"]))).toBeNull();
  });

  it("collapses a nested branch left empty, keeping a surviving sibling subtree", () => {
    const layout = {
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "branch",
              data: [
                { type: "leaf", data: { views: ["a"], activeView: "a" }, size: 250 },
                { type: "leaf", data: { views: ["b"], activeView: "b" }, size: 250 },
              ],
              size: 500,
            },
            { type: "leaf", data: { views: ["c"], activeView: "c" }, size: 500 },
          ],
        },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { a: { id: "a" }, b: { id: "b" }, c: { id: "c" } },
    };
    const pruned = pruneLayout(layout, new Set(["c"])) as any;
    expect(panelIdsInLayout(pruned)).toEqual(["c"]);
    // The nested branch holding "a" and "b" is removed entirely rather than left empty.
    expect(pruned.grid.root.data).toHaveLength(1);
    expect(pruned.grid.root.data[0].data.views).toEqual(["c"]);
  });

  it("repairs a dangling activeGroup to a surviving group", () => {
    const layout = {
      grid: {
        root: {
          type: "branch",
          data: [
            { type: "leaf", data: { id: "1", views: ["a"], activeView: "a" }, size: 500 },
            { type: "leaf", data: { id: "2", views: ["b"], activeView: "b" }, size: 500 },
          ],
        },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { a: { id: "a" }, b: { id: "b" } },
      activeGroup: "2",
    };
    // Removing "b" destroys group "2" entirely; activeGroup must be repointed at "1".
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    expect(pruned.activeGroup).toBe("1");
  });

  it("drops activeGroup when no surviving group id can be identified", () => {
    // twoPaneLayout's leaves carry no `id`, so a dangling activeGroup can't be repointed.
    const pruned = pruneLayout(twoPaneLayout(), new Set(["a"])) as any;
    expect("activeGroup" in pruned).toBe(false);
  });

  it("prunes a leaf's tab groups, dropping one left with no panels", () => {
    const layout = {
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "leaf",
              data: {
                views: ["a", "b", "c"],
                activeView: "b",
                tabGroups: [
                  { id: "tg1", panelIds: ["a", "b"] },
                  { id: "tg2", panelIds: ["c"] },
                ],
              },
              size: 1000,
            },
          ],
        },
        width: 1000,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: { a: { id: "a" }, b: { id: "b" }, c: { id: "c" } },
    };
    // Removing "b" and "c": tg1 keeps only "a"; tg2 loses its only panel and is dropped.
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    const leaf = pruned.grid.root.data[0].data;
    expect(leaf.views).toEqual(["a"]);
    expect(leaf.activeView).toBe("a");
    expect(leaf.tabGroups).toEqual([{ id: "tg1", panelIds: ["a"] }]);
  });

  it("drops floatingGroups when they reference a removed panel", () => {
    const layout = {
      ...twoPaneLayout(),
      floatingGroups: [
        { data: { id: "3", views: ["b"], activeView: "b" }, position: { top: 0, left: 0, width: 100, height: 100 } },
      ],
    };
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    expect("floatingGroups" in pruned).toBe(false);
  });

  it("keeps floatingGroups untouched when every panel inside them survives", () => {
    const layout = {
      ...twoPaneLayout(),
      floatingGroups: [
        { data: { id: "3", views: ["a"], activeView: "a" }, position: { top: 0, left: 0, width: 100, height: 100 } },
      ],
    };
    // Removing "b" (a plain grid panel) doesn't touch floatingGroups, whose only panel ("a") survives.
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    expect(pruned?.floatingGroups).toEqual(layout.floatingGroups);
  });

  it("drops popoutGroups when a panel inside their nested grid was removed", () => {
    const layout = {
      ...twoPaneLayout(),
      popoutGroups: [
        {
          grid: {
            root: { type: "leaf", data: { id: "4", views: ["b"], activeView: "b" }, size: 500 },
            width: 400,
            height: 300,
            orientation: "HORIZONTAL",
          },
          position: null,
        },
      ],
    };
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    expect("popoutGroups" in pruned).toBe(false);
  });

  it("drops edgeGroups when the docked group references a removed panel", () => {
    const layout = {
      ...twoPaneLayout(),
      edgeGroups: { left: { size: 200, visible: true, group: { id: "5", views: ["b"], activeView: "b" } } },
    };
    const pruned = pruneLayout(layout, new Set(["a"])) as any;
    expect("edgeGroups" in pruned).toBe(false);
  });
});
