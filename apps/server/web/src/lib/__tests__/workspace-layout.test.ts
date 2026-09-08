import { describe, expect, it } from "bun:test";
import type { WorkspacePaneRow } from "@/types/workspace";
import {
  normalizeLegacyLayout,
  panelIdsInLayout,
  panesMissingFromLayout,
  resolveAddPosition,
} from "../workspace-layout";

function pane(id: string): WorkspacePaneRow {
  return {
    id,
    subshellId: `s-${id}`,
    subshellName: id,
    subshellStatus: "running",
    subshellAlive: true,
    subshellExitCode: null,
    subshellWaitingSince: null,
    workingDir: "/tmp",
  };
}

const layout = { grid: {}, panels: { a: { id: "a" } } };

describe("panelIdsInLayout", () => {
  it("lists panel ids", () => {
    expect(panelIdsInLayout(layout)).toEqual(["a"]);
  });

  it("treats a null or malformed layout as empty", () => {
    expect(panelIdsInLayout(null)).toEqual([]);
    expect(panelIdsInLayout({})).toEqual([]);
  });
});

describe("panesMissingFromLayout", () => {
  it("returns panes the layout does not mention", () => {
    expect(panesMissingFromLayout(layout, [pane("a"), pane("b")]).map((p) => p.id)).toEqual(["b"]);
  });

  it("returns every pane when there is no layout at all", () => {
    expect(panesMissingFromLayout(null, [pane("a"), pane("b")]).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("returns nothing when the layout covers every pane", () => {
    expect(panesMissingFromLayout(layout, [pane("a")])).toEqual([]);
  });
});

describe("resolveAddPosition", () => {
  it("splits from the reference pane when one is given", () => {
    expect(resolveAddPosition("right", "pane-1")).toEqual({ referencePanel: "pane-1", direction: "right" });
  });

  it("accepts 'within' when a reference pane is given", () => {
    expect(resolveAddPosition("within", "pane-1")).toEqual({ referencePanel: "pane-1", direction: "within" });
  });

  it("falls back to a bare container edge for left/right/above/below with no reference", () => {
    expect(resolveAddPosition("left")).toEqual({ direction: "left" });
    expect(resolveAddPosition("above")).toEqual({ direction: "above" });
  });

  it("omits position entirely for 'within' with no reference — dockview's AbsolutePosition excludes it", () => {
    expect(resolveAddPosition("within")).toBeUndefined();
  });
});

describe("normalizeLegacyLayout", () => {
  /** A snapshot as dockview 8.2's `toJSON` wrote it BEFORE the component rename:
   * panels keyed by the server's pane id (never "session:..."), each stamped
   * with `contentComponent: "session"`, referenced by id from the grid leaves. */
  function legacyLayout() {
    return {
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "branch",
              data: [
                { type: "leaf", data: { id: "group-1", views: ["pane-a", "pane-b"], activeView: "pane-b" } },
                {
                  type: "leaf",
                  data: { id: "group-2", views: ["pane-c"], tabGroups: [{ views: ["pane-c"] }] },
                },
              ],
            },
          ],
        },
      },
      panels: {
        "pane-a": { id: "pane-a", contentComponent: "session", title: "alpha", renderer: "always" },
        "pane-b": { id: "pane-b", contentComponent: "session", params: { paneId: "pane-b" }, renderer: "always" },
        "pane-c": { id: "pane-c", contentComponent: "session", title: "gamma" },
      },
      activeGroup: "group-1",
    };
  }

  it("rewrites every legacy contentComponent to 'subshell' at any nesting depth", () => {
    const out = normalizeLegacyLayout(legacyLayout()) as ReturnType<typeof legacyLayout>;
    expect(Object.values(out.panels).map((p) => p.contentComponent)).toEqual(["subshell", "subshell", "subshell"]);
  });

  it("leaves the grid (ids, views, activeView) and everything else untouched", () => {
    const input = legacyLayout();
    const out = normalizeLegacyLayout(input) as ReturnType<typeof legacyLayout>;
    // Panel ids never embedded the component key, so grid references stay valid as-is.
    expect(out.grid).toEqual(input.grid);
    expect(out.activeGroup).toBe("group-1");
    expect(out.panels["pane-b"].params).toEqual({ paneId: "pane-b" });
  });

  it("does not mutate the input", () => {
    const input = legacyLayout();
    normalizeLegacyLayout(input);
    expect(input.panels["pane-a"].contentComponent).toBe("session");
  });

  it("passes a modern layout through unchanged", () => {
    const modern = {
      grid: { root: { type: "leaf", data: { id: "group-1", views: ["pane-a"], activeView: "pane-a" } } },
      panels: { "pane-a": { id: "pane-a", contentComponent: "subshell", title: "alpha", renderer: "always" } },
      activeGroup: "group-1",
    };
    // Copy-on-write: not just deep-equal, the very same reference comes back.
    expect(normalizeLegacyLayout(modern)).toBe(modern);
  });

  it("survives null, primitives, arrays and junk without throwing", () => {
    for (const junk of [null, undefined, 0, "", "session", true, [], {}, [1, "two"], { a: [null, { b: 1 }] }]) {
      expect(() => normalizeLegacyLayout(junk)).not.toThrow();
    }
    expect(normalizeLegacyLayout(null)).toBeNull();
    expect(normalizeLegacyLayout("session")).toBe("session");
  });

  it("rewrites a legacy key nested in an array or bare object, not just dockview shapes", () => {
    expect(normalizeLegacyLayout([{ contentComponent: "session" }])).toEqual([{ contentComponent: "subshell" }]);
    expect(normalizeLegacyLayout({ deep: { contentComponent: "session" } })).toEqual({
      deep: { contentComponent: "subshell" },
    });
  });
});
