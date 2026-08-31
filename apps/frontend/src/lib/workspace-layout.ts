import type { AddPanelPositionOptions } from "dockview-react";
import type { SplitDirection, WorkspacePaneRow } from "@/types/workspace";

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every panel id referenced by a serialized dockview layout.
 *
 * @param layout - A serialized layout, or anything at all
 * @returns The panel ids, empty if the input is not a layout
 */
export function panelIdsInLayout(layout: unknown): string[] {
  if (!isRecord(layout) || !isRecord(layout.panels)) return [];
  return Object.keys(layout.panels);
}

/**
 * Panes that exist server-side but have no panel in the stored layout — added
 * from another device, or from the narrow presentation which never writes the
 * layout. The caller appends them as tabs in the active group.
 *
 * The mirror of the server's pruning: the server drops panels with no pane,
 * this finds panes with no panel.
 *
 * @param layout - The stored layout, possibly null
 * @param panes - The panes the server returned
 * @returns The panes to append, in server order
 */
export function panesMissingFromLayout(layout: unknown, panes: WorkspacePaneRow[]): WorkspacePaneRow[] {
  const known = new Set(panelIdsInLayout(layout));
  return panes.filter((p) => !known.has(p.id));
}

/**
 * Builds dockview's `addPanel` position for a requested split.
 *
 * With a reference pane, splits from it directly — this is the only shape
 * that accepts `"within"`, since dockview's reference-less `AbsolutePosition`
 * variant explicitly excludes it (there is nothing to be "within" without a
 * reference). With no reference at all — an empty workspace, or a `"within"`
 * request the caller had no active pane to resolve against — a left/right/
 * above/below request still lands at a bare container edge, while `"within"`
 * has no sensible fallback and is left as "no position", which dockview
 * resolves to its own default: the first panel in a fresh group.
 *
 * @param direction - Where the new pane should go
 * @param referencePaneId - The pane to split from, if any
 * @returns Options for `DockviewApi.addPanel`, or `undefined` for dockview's own default placement
 */
export function resolveAddPosition(
  direction: SplitDirection,
  referencePaneId?: string,
): AddPanelPositionOptions | undefined {
  if (referencePaneId) return { referencePanel: referencePaneId, direction };
  if (direction === "within") return undefined;
  return { direction };
}
