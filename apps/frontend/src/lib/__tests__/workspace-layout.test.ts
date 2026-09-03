import { describe, expect, it } from "bun:test";
import type { WorkspacePaneRow } from "@/types/workspace";
import { panelIdsInLayout, panesMissingFromLayout, resolveAddPosition } from "../workspace-layout";

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
