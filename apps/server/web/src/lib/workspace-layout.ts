import type { AddGroupOptions, AddPanelPositionOptions, DockviewApi } from "dockview-react";
import type { SplitDirection, WorkspacePaneRow } from "@/types/workspace";

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrites the legacy dockview component key on a persisted layout.
 *
 * The workspace rename changed the panel content renderer's id from
 * `"session"` to `"subshell"` (components map in `workspace-dock.tsx`), but
 * saved layouts predate it: dockview 8.2's `DockviewComponent.toJSON()`
 * stamps every panel's renderer id into `panels[id].contentComponent`, and
 * `fromJSON` throws while deserializing a key the components registry no
 * longer has (`ReactPart.createPortal` rejects the undefined component),
 * which would drop the user back on a fresh full-rebuild layout.
 *
 * Only `contentComponent` carries the key. Panels are added as
 * `addPanel({ id: pane.id })` — the server's pane UUID — and every other
 * serialized reference (grid leaf `views`/`activeView`/`tabGroups`,
 * `activeGroup`) names panels and groups by those ids, never by component
 * name; per-panel `tabComponent` is never set here (the app uses
 * `defaultTabComponent`). So a recursive rewrite of that one field is
 * complete — no id/reference rewriting is needed.
 *
 * Copy-on-write: an input with no legacy key is returned as the same
 * reference; a changed subtree is cloned, never mutated in place.
 *
 * @param layout - A serialized layout, or anything at all
 * @returns The same layout with every `contentComponent: "session"` rewritten to `"subshell"`
 */
export function normalizeLegacyLayout(layout: unknown): unknown {
  if (Array.isArray(layout)) {
    let changed = false;
    const items = layout.map((item) => {
      const next = normalizeLegacyLayout(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : layout;
  }
  if (!isRecord(layout)) return layout;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layout)) {
    if (key === "contentComponent" && value === "session") {
      changed = true;
      out[key] = "subshell";
      continue;
    }
    const next = normalizeLegacyLayout(value);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : layout;
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

/**
 * The `addGroup` target that splits an EXISTING panel out of its tab group,
 * which is what the tab's context menu offers. Dockview's own split gesture
 * is tab-drag-to-edge and it works (verified live in all three engines,
 * Firefox), but dropping a tab on a group's CENTER is a merge that reads as
 * a no-op, and nothing on screen names either one, so the operator reports
 * "dragging does nothing". The menu drives this instead.
 *
 * The panel is MOVED, never recreated: the caller runs `api.addGroup(target)`
 * to build the empty destination group beside this panel's group (a split,
 * not the container-edge move a reference-less `moveTo` would give), then
 * `panel.api.moveTo({ group })` relocates the same panel object into it, so
 * its `renderer: "always"` terminal keeps its DOM and socket. Dockview
 * destroys the source group itself when a move empties it
 * (`moveGroupOrPanel` removes an emptied source group), so a last-panel move
 * never leaves a husk; with a one-tab group the split is a visual no-op for
 * exactly that reason, the same answer the drag gesture gives.
 *
 * @param api - The live dockview api; only `getPanel` is read
 * @param panelId - The panel the right-clicked tab belongs to
 * @param direction - Where the destination group goes. "within" is tab
 *   placement, not a split, and is unrepresentable here
 * @returns Options for `DockviewApi.addGroup`, or null when no such panel exists
 */
export function splitTarget(
  api: Pick<DockviewApi, "getPanel">,
  panelId: string,
  direction: Exclude<SplitDirection, "within">,
): AddGroupOptions | null {
  if (!api.getPanel(panelId)) return null;
  return { referencePanel: panelId, direction };
}
