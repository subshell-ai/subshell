/**
 * dockview's serialized layout. Treated as opaque apart from the panel and
 * group references we prune or repair (`panels`, `grid`, `activeGroup`,
 * `floatingGroups`, `popoutGroups`, `edgeGroups`).
 */
export interface SerializedLayout {
  [key: string]: unknown;
}

/** A grid node: either a branch of more nodes, or a leaf holding panel ids. */
interface GridNode {
  /** "branch" for an internal split, "leaf" for a pane-holding group. */
  type?: string;
  /** A branch's child nodes, or a leaf's payload. */
  data?: GridNode[] | LeafData;
  /** Relative size within its parent split; irrelevant to pruning. */
  size?: number;
}

/** A leaf's payload: dockview's `GroupPanelViewState`, pared down to the fields this module reads or repairs. */
interface LeafData {
  /** The leaf's own group id (distinct from the panel ids it holds); used to repair a dangling `activeGroup`. */
  id?: string;
  /** Panel ids hosted by this leaf. */
  views?: string[];
  /** Which of `views` currently has focus. */
  activeView?: string;
  /** Chips that visually merge a subset of `views` into one tab; each `panelIds` is a subset of `views`. */
  tabGroups?: TabGroupLike[];
}

/** A dockview tab group: a chip that merges a subset of a leaf's panels into one tab. */
interface TabGroupLike {
  /** Panel ids merged under this chip. Always a subset of the owning leaf's `views`. */
  panelIds?: string[];
  [key: string]: unknown;
}

/** True when the value is a non-null object (and not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every panel id referenced by a serialized layout.
 *
 * Reads the `panels` map rather than walking the grid: dockview keys that map
 * by panel id, so it is the authoritative list and cannot disagree with itself.
 * A panel referenced from anywhere else in the layout — a grid leaf, a
 * floating/popout window, an edge group — is necessarily also a key of
 * `panels`, since that map is dockview's flat registry of every panel that
 * exists, independent of where it's currently placed. So there is no panel id
 * that could be found only by walking those other fields.
 *
 * @param layout - A serialized dockview layout, or anything at all
 * @returns The panel ids, or an empty array if the input is not a layout
 */
export function panelIdsInLayout(layout: unknown): string[] {
  if (!isRecord(layout) || !isRecord(layout.panels)) return [];
  return Object.keys(layout.panels);
}

/**
 * Removes panels whose pane row no longer exists, and any leaf or branch left
 * empty by their removal.
 *
 * This is the server's half of keeping `layout_json` honest against
 * `workspace_panes`: a subshell delete cascades a pane away without touching the
 * stored layout, so the layout is filtered on read rather than swept in the
 * background.
 *
 * @param layout - The stored layout
 * @param livePaneIds - Ids of the panes that still exist
 * @returns The pruned layout, or null if it is malformed or nothing survives
 */
export function pruneLayout(layout: unknown, livePaneIds: ReadonlySet<string>): SerializedLayout | null {
  if (!isRecord(layout) || !isRecord(layout.panels) || !isRecord(layout.grid)) return null;

  const panelIds = Object.keys(layout.panels);
  const survivors = panelIds.filter((id) => livePaneIds.has(id));
  if (survivors.length === 0) return null;

  const panels: Record<string, unknown> = {};
  for (const id of survivors) panels[id] = (layout.panels as Record<string, unknown>)[id];

  // Prune the grid against the ids that actually survived into `panels`, not
  // against `livePaneIds`. The two differ for a view naming a live pane that
  // the layout never had a `panels` entry for — dockview's own `toJSON` never
  // emits that, but the layout body is stored as given, so a hand-written PUT
  // could otherwise leave a view with no registry entry behind.
  const survivorSet = new Set(survivors);
  const root = pruneNode((layout.grid as Record<string, unknown>).root, survivorSet);
  if (!root) return null;

  const result: SerializedLayout = { ...layout, grid: { ...(layout.grid as Record<string, unknown>), root }, panels };

  // Every field handled below can only go stale as a direct result of a panel
  // actually disappearing from `panels`. If this call's livePaneIds already
  // accounted for every panel the layout knew about, nothing below can be
  // dangling, so skip touching them and hand back an otherwise-identical layout.
  // Nothing left `panels`, so for any layout dockview itself produced — where
  // every grid view has a `panels` entry — nothing below can be dangling
  // either, and the layout is handed back otherwise byte-identical. (A
  // hand-written PUT naming a view with no `panels` entry could still lose a
  // leaf here; `fromJSON` rejects such a layout outright anyway, and the dock
  // falls through to laying the panes out fresh.)
  if (survivors.length === panelIds.length) return result;

  // A dangling `activeGroup` names a leaf whose whole group pruning removed.
  // Repoint it at any surviving group, or drop it if none can be identified
  // (a leaf missing its own `id`, which real dockview output always sets).
  const survivingGroupIds = new Set(collectGroupIds(root));
  if (typeof layout.activeGroup === "string" && !survivingGroupIds.has(layout.activeGroup)) {
    const [fallback] = survivingGroupIds;
    if (fallback !== undefined) result.activeGroup = fallback;
    else delete result.activeGroup;
  }

  // floatingGroups/popoutGroups/edgeGroups are never created by this app.
  // Rather than partially repair shapes we don't fully model — risking a
  // layout dockview rejects outright on fromJSON, a worse failure than the
  // staleness we're fixing — drop the whole field the moment anything inside
  // it still names a panel that no longer exists.
  for (const field of ["floatingGroups", "popoutGroups"] as const) {
    const entries = layout[field];
    if (
      Array.isArray(entries) &&
      entries.some((entry) => viewIdsInWindowEntry(entry).some((id) => !livePaneIds.has(id)))
    ) {
      delete result[field];
    }
  }
  if (viewIdsInEdgeGroups(layout.edgeGroups).some((id) => !livePaneIds.has(id))) {
    delete result.edgeGroups;
  }

  return result;
}

/** Prunes one grid node, returning null when nothing in it survives. */
function pruneNode(node: unknown, live: ReadonlySet<string>): GridNode | null {
  if (!isRecord(node)) return null;
  const typed = node as GridNode;

  if (Array.isArray(typed.data)) {
    const children = typed.data.map((child) => pruneNode(child, live)).filter((c): c is GridNode => c !== null);
    if (children.length === 0) return null;
    return { ...typed, data: children };
  }

  if (isRecord(typed.data)) {
    const views = Array.isArray(typed.data.views) ? typed.data.views.filter((v) => live.has(v)) : [];
    if (views.length === 0) return null;
    // activeView may name a removed panel; fall back to the first survivor.
    const activeView =
      typeof typed.data.activeView === "string" && views.includes(typed.data.activeView)
        ? typed.data.activeView
        : views[0];
    const data: LeafData = { ...typed.data, views, activeView };
    if (Array.isArray(typed.data.tabGroups)) {
      data.tabGroups = pruneTabGroups(typed.data.tabGroups, live);
    }
    return { ...typed, data };
  }

  return null;
}

/**
 * Prunes each tab group's member panel ids against `live`, dropping a tab
 * group left with none. A tab group's `panelIds` is always a subset of its
 * owning leaf's `views`, which is filtered the same way immediately before
 * this runs, so the two stay consistent with each other. There is no
 * separate "active tab" pointer to repair: the leaf's own `activeView` is
 * what names the currently-focused panel regardless of tab-group membership,
 * and it is already validated against the (already-pruned) `views` array.
 *
 * @param tabGroups - The leaf's raw tab groups
 * @param live - Ids of the panes that still exist
 * @returns The pruned tab groups, possibly empty
 */
function pruneTabGroups(tabGroups: unknown[], live: ReadonlySet<string>): TabGroupLike[] {
  return tabGroups
    .filter(isRecord)
    .map((group) => ({
      ...group,
      panelIds: Array.isArray(group.panelIds)
        ? group.panelIds.filter((id) => typeof id === "string" && live.has(id))
        : [],
    }))
    .filter((group) => group.panelIds.length > 0);
}

/**
 * Ids of every surviving leaf's own group (its `id`, distinct from the panel
 * ids it holds). Used to repair a dangling `activeGroup` after pruning.
 */
function collectGroupIds(node: GridNode): string[] {
  if (Array.isArray(node.data)) return node.data.flatMap(collectGroupIds);
  return isRecord(node.data) && typeof node.data.id === "string" ? [node.data.id] : [];
}

/** Panel ids inside a single serialized group (a leaf's or a floating/popout window's single-group payload). */
function viewIdsOfGroupState(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.views)) return [];
  return value.views.filter((id): id is string => typeof id === "string");
}

/** Panel ids referenced anywhere inside a grid subtree, read-only — used to inspect a floating/popout window's nested layout without mutating it. */
function collectViewIdsFromGrid(node: unknown): string[] {
  if (!isRecord(node)) return [];
  if (Array.isArray(node.data)) return node.data.flatMap(collectViewIdsFromGrid);
  return viewIdsOfGroupState(node.data);
}

/** Every panel id referenced by one floating or popout window entry: its single-group form, or its nested grid. */
function viewIdsInWindowEntry(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  const gridRoot = isRecord(entry.grid) ? entry.grid.root : undefined;
  return [...viewIdsOfGroupState(entry.data), ...collectViewIdsFromGrid(gridRoot)];
}

/** The four edge-dock positions dockview supports. */
const EDGE_POSITIONS = ["top", "bottom", "left", "right"] as const;

/** Every panel id referenced anywhere inside `edgeGroups`. */
function viewIdsInEdgeGroups(edgeGroups: unknown): string[] {
  if (!isRecord(edgeGroups)) return [];
  return EDGE_POSITIONS.flatMap((position) => {
    const entry = edgeGroups[position];
    return isRecord(entry) ? viewIdsOfGroupState(entry.group) : [];
  });
}
