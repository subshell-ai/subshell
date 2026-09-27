import { Input } from "@internal/node-admin";
import { useLocation } from "@tanstack/react-router";
import { ChevronsDownUp, ChevronsUpDown, Grid3x3, LayoutGrid, List } from "lucide-react";
import { type RefObject, useCallback, useMemo, useState } from "react";
import { SubshellNodeGroup } from "@/components/sidebar/SubshellNodeGroup";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { flatCellRows, nodeTintBucket, paneInitial, SubshellCellGrid } from "@/components/sidebar/subshell-cell-grid";
import { TippedIconButton } from "@/components/tipped-icon-button";
import { Segmented } from "@/components/ui/segmented";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { usePresets } from "@/hooks/use-presets";
import { useWorkspace } from "@/hooks/use-workspace";
import { subshellIdFromPath, workspaceIdFromPath } from "@/lib/route-ids";
import {
  collapsedNodeGroups,
  commsGroupOpen,
  othersGroupOpen,
  setCollapsedNodeGroups,
  setCommsGroupOpen,
  setOthersGroupOpen,
  setWorkspaceGroupOpen,
  toggleNodeGroup,
  workspaceGroupOpen,
} from "@/lib/sidebar-node-group-pref";
import { type RailSubshellsView, railSubshellsView, setRailSubshellsView } from "@/lib/sidebar-rail-view-pref";
import { RECENT_LIMIT } from "@/lib/sidebar-recents";
import { filterSubshells } from "@/lib/subshell-filter";
import {
  CROSS_AGENT_GROUP_ID,
  FALLBACK_NODE_ID,
  groupSubshellsByNode,
  needsAttention,
  nodeLabelFor,
  partitionCrossAgent,
} from "@/lib/subshell-node-groups";
import { useWorkspaceFocusedId } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";

/**
 * The synthetic id the collapsible "Workspace" section carries into
 * `SubshellNodeGroup`, the same way cross-agent comms is filed under
 * `CROSS_AGENT_GROUP_ID`. It keys `aria-controls` and the section's own collapse
 * preference; it is never a node id and never rendered.
 */
const WORKSPACE_GROUP_ID = "workspace";

/**
 * The synthetic id for the flat view's counterpart section, "Others": the
 * subshells that are NOT panes of the current workspace. Like the Workspace group
 * it exists only while a workspace page is open, so the two read as distinguishable
 * halves rather than one merged grid.
 */
const OTHERS_GROUP_ID = "others";

/**
 * The rail's whole subshell section: the mode control, the filter box, the
 * Needs Attention spotlight, the Cross-agent comms section and the machine
 * groups, in one of THREE renderings behind a single choice.
 *
 * - `rows` (the default): text rows — the shape the rail has always had.
 * - `cells`: the same machine groups (headers, counts, collapse prefs,
 *   filter-forced-open and all), but every row is a status square from the
 *   dot's own table (`subshell-cell-grid.tsx`), each wearing its pane's
 *   initial.
 * - `cells-flat`: no headers, one grid of squares sorted by the shared status
 *   band, urgency top-left. Each cell rides a machine-tint plate hashed from
 *   its node name (the clustering cue headers used to be) and carries the
 *   PANE's initial; the machine's own name lives in the tooltip's Node line.
 *
 * The mode is a per-device preference (`lib/sidebar-rail-view-pref.ts`), and
 * all three modes read the SAME derivation pipeline — one filtered list, one
 * cross-agent partition, one grouping pass — so a mode switch changes shape
 * only, never which panes are visible or their caps. The flat grid folds the
 * Needs Attention spotlight INTO its one grid (the SIMPLER of the two shapes
 * the design allowed, and the one that keeps every cell truthful: a spotlight
 * row carries its own machine's tint plate and its own letter, exactly as it
 * sits in its group). Grouped cells mode keeps the spotlight and comms as
 * headed sections, because there their headers carry counts that would be
 * lost in a single field, and it renders no plates — the headers already
 * name the machine.
 *
 * Activity is derived against the clock, and the tick lives in AppSidebar
 * (ONE per surface, never one per row) — this component renders under it.
 *
 * `filterRef` is threaded in rather than created here because the desktop
 * shell's ⌘F (View menu → focus filter) drives it from AppSidebar, which also
 * owns the collapsed-rail dance: the input only exists while this section is
 * mounted expanded, and the caller's effect focuses it once it does.
 */
export function RailSubshells({
  filterRef,
  query,
  onQueryChange,
}: {
  filterRef: RefObject<HTMLInputElement | null>;
  /**
   * The filter text, OWNED BY AppSidebar: this whole section unmounts while
   * the rail is collapsed, and a query kept in this component's own state
   * died with the unmount (a 2026-09-25 review caught the extraction
   * quietly changing that lifetime). The mode and collapse preferences are
   * localStorage-backed and survive on their own; only this keystroke-level
   * state needs a parent that outlives the collapse.
   */
  query: string;
  onQueryChange: (next: string) => void;
}) {
  const location = useLocation();
  // Same query keys the home page and every mutation already share — these
  // reads are cache hits for a rail that lives in the same tree.
  const { data: nodeData } = useNodes();
  // Names only, over the catalog the launch pickers already cache. An
  // unresolvable harness degrades to its id, which is a readable slug
  // ("claude-code") — see the clone dialog, which makes the same trade.
  const { data: pluginData } = useInstancePlugins();
  const agentLabel = useCallback(
    (harnessId: string) => pluginData?.plugins.find((p) => p.id === harnessId)?.name ?? harnessId,
    [pluginData],
  );
  // The tooltip's `Preset:` line, same caller-resolves pattern: one read of
  // the list the launch form and /presets already cache, keyed alike. A
  // presetId that names no row (loading, or since deleted) degrades to the
  // id — the row HAS a preset, and that is the fact worth showing.
  const { data: presetData } = usePresets();
  const presetLabel = useCallback(
    (presetId: string | null): string | undefined =>
      presetId === null ? undefined : (presetData?.find((p) => p.id === presetId)?.name ?? presetId),
    [presetData],
  );
  // Filter mode replaces the recents with matches over the FULL cached list
  // (no server call — the list is already client-side). Same predicate as
  // the home page and the add-subshell dialog (lib/subshell-filter).
  const q = query.trim();
  // Sorted by liveness BEFORE the recents slice (band order documented in
  // use-ordered-subshells), so a pile of old ended sessions can never crowd a
  // live one out of the rail. The filter mode shares the same run.
  const byStatus = useOrderedSubshells();
  // The one filtered list all three modes read: the machine groups, the comms
  // section AND the Needs Attention spotlight. Deriving it once makes "the
  // spotlight sees the exact rows the groups see" a fact of the code rather
  // than two identical expressions kept in sync by a comment.
  const railRows = q ? filterSubshells(byStatus, query) : byStatus;
  // Panes an AGENT opened over MCP leave the machine groups entirely
  // (operator ask 2026-09-25): they are internal cross-agent comms, filed in
  // one section of their own ABOVE the machine groups (moved from below on
  // operator ask 2026-09-26), each row naming the machine it runs on since
  // the section spans them. The partition runs on the FILTERED list, so a
  // search matches them exactly like a machine's rows.
  const { human: railHuman, comms: railComms } = partitionCrossAgent(railRows);
  const commsGroup = {
    nodeId: CROSS_AGENT_GROUP_ID,
    label: "Cross-agent comms",
    // The header's hover line is the whole explanation; two sentences max,
    // per the design system's rule for UI text.
    title:
      "Panes an agent opened over MCP to talk to another agent. Created with the bell off; toggle it from a row's menu.",
    total: railComms.length,
    // The same per-group cap the machines get, and the same exemption while
    // filtering: a search that hid its own ninth match lies.
    subshells: q === "" ? railComms.slice(0, RECENT_LIMIT) : railComms,
  };
  // NOT memoised, deliberately: a group's rank re-derives activity against
  // the CLOCK, so a `useMemo` keyed on the data would freeze the group order
  // between feed frames and undo the liveliest-member ordering the 20 s tick
  // exists to maintain. The pass is O(rows) with a Map, per tick and per
  // keystroke — the frame it costs is one the rail re-renders for anyway.
  const nodeGroups = groupSubshellsByNode(railHuman, nodeData?.nodes, {
    limit: q ? undefined : RECENT_LIMIT,
    // "Unanswered" means NO successful read has ever committed: in flight, or
    // failed with nothing cached. It cannot be `isPending || isError` — a
    // background REFRESH that fails on a populated cache reports `isError`
    // while keeping the data, and re-labelling resolved headers to short ids
    // on a transient blip would be the header flickering a doubt it has no
    // reason to hold. Stale-but-cached beats a verdict from a failed retry.
    unanswered: nodeData === undefined,
  });
  // The "Needs Attention" spotlight above the machine groups (spec 2026-09-24):
  // `railRows` — the same rows the groups are built from — narrowed to the
  // owner's unseen pushes. Computed from the filter set, not from `nodeGroups`,
  // so a match in filter mode shows here exactly as it shows in the
  // (forced-open) group, and the cap that groups apply never hides a pane that
  // pushed.
  const attentionRows = needsAttention(railRows);
  // The "No matches" empty state must count the comms section too: a filter
  // that hits only a cross-agent pane would otherwise say "No matches" above a
  // row it is showing. The flat grid needs no second count — while filtering
  // the caps are off, so it holds exactly these rows (and a Needs-Attention row
  // shows in BOTH its band and its machine cluster, per the four-band order).
  const listedCount = nodeGroups.reduce((sum, group) => sum + group.subshells.length, 0) + commsGroup.subshells.length;
  // Which node groups this device has shut. Read once at mount — the rail
  // lives for the session, so re-reading storage on every render would buy
  // nothing but a synchronous read per frame.
  const [collapsedGroups, setCollapsedGroups] = useState(collapsedNodeGroups);
  const toggleNodeGroupOpen = useCallback((nodeId: string) => {
    setCollapsedGroups((prev) => setCollapsedNodeGroups(toggleNodeGroup(prev, nodeId)));
  }, []);
  // The comms section's own open state: CLOSED until this device opens it
  // (operator ask 2026-09-25), because its rows can multiply silently while
  // the machines' groups cannot. Separate pref for the inverted default (see
  // `sidebar-node-group-pref.ts`).
  const [commsOpen, setCommsOpen] = useState(commsGroupOpen);
  const toggleCommsOpen = useCallback(() => {
    setCommsOpen((prev) => setCommsGroupOpen(!prev));
  }, []);
  // The "Workspace" section collapses on its own preference (operator ask
  // 2026-09-27), keyed to the remembered OPEN state and defaulting OPEN — the
  // workspace you opened is the work you came to look at.
  const [workspaceOpen, setWorkspaceOpen] = useState(workspaceGroupOpen);
  const toggleWorkspaceOpen = useCallback(() => {
    setWorkspaceOpen((prev) => setWorkspaceGroupOpen(!prev));
  }, []);
  // The flat view's "Others" section collapses on its own preference (operator
  // ask 2026-09-27), defaulting OPEN like its Workspace counterpart.
  const [othersOpen, setOthersOpen] = useState(othersGroupOpen);
  const toggleOthersOpen = useCallback(() => {
    setOthersOpen((prev) => setOthersGroupOpen(!prev));
  }, []);
  // The rendering mode, read once at mount like every other rail pref.
  const [view, setView] = useState(railSubshellsView);
  const changeView = useCallback((next: RailSubshellsView) => {
    setView(setRailSubshellsView(next));
  }, []);

  // The cell modes need a per-row machine label (the grouped modes read it
  // from the header's `label`; the comms and spotlight rows span machines).
  // Same ladder the headers use — one answer per machine per render.
  const machineLabel = useCallback(
    (sub: SubshellView) => nodeLabelFor(sub.nodeId || FALLBACK_NODE_ID, nodeData?.nodes, nodeData === undefined).label,
    [nodeData],
  );
  // SELECTED is the SET of open panes — the viewed `/subshells/:id` plus every
  // pane the current `/workspaces/:id` holds open (the SAME cached query the
  // route runs, a hit while a workspace page is up, disabled elsewhere).
  // FOCUSED is the single pane: the URL's on a subshell page, or the one the
  // DOCK has active on a workspace page (the dock publishes it through
  // `lib/workspace-focus`; the sidebar is a different tree and cannot otherwise
  // see dockview's focus). The set marks every open cell/row. On the ROWS the
  // two still differ (set = accent fill, focus adds the ring); on the CELLS one
  // ring now covers both (operator 2026-09-27: the wide focus ring read heavy).
  const focusedFromUrl = subshellIdFromPath(location.pathname);
  const workspaceId = workspaceIdFromPath(location.pathname);
  const { data: workspaceDetail } = useWorkspace(workspaceId ?? "", { enabled: workspaceId !== null });
  const dockFocusedId = useWorkspaceFocusedId();
  const focusedId = focusedFromUrl ?? dockFocusedId;
  // Only inside a workspace page (a dock is up to act on a focus request) does
  // clicking an open pane focus its tab rather than navigate out.
  const onWorkspace = workspaceId !== null;
  const selectedIds = useMemo(() => {
    const ids = new Set<string>();
    if (focusedFromUrl) ids.add(focusedFromUrl);
    for (const pane of workspaceDetail?.panes ?? []) ids.add(pane.subshellId);
    return ids;
  }, [focusedFromUrl, workspaceDetail]);
  // In the grouped shapes (rows and headed cells) the selection promotes whole
  // SECTIONS: a machine group holding a selected pane leads. Stable otherwise,
  // so the grouped mode's own liveliest-member rank is untouched within each
  // half. The flat grid does this at cell level inside `flatCellRows`.
  const orderedNodeGroups = [
    ...nodeGroups.filter((group) => group.subshells.some((sub) => selectedIds.has(sub.id))),
    ...nodeGroups.filter((group) => !group.subshells.some((sub) => selectedIds.has(sub.id))),
  ];

  // The flat grid's cell set, in the four bands (notifications → machines with
  // a selection → other machines → comms). Recomputed per render like the
  // grouping itself: it is that output re-sorted, so the two modes cannot
  // disagree about which panes are on screen.
  const flatRows = flatCellRows(nodeGroups, commsGroup.subshells, attentionRows, selectedIds);

  // The "Workspace" section (operator ask 2026-09-27): the panes of the
  // workspace you are standing in, surfaced as the TOPMOST item in every view.
  // A sibling, not an extraction — the same panes stay in their machine groups /
  // flat clusters below (selection ordering kept), so a pane appears in the
  // Workspace section AND its machine group, as the Needs Attention spotlight
  // already does. Rows carry their machine as a third line, because a Workspace
  // header spans hosts. Pane order is the dock's, not the status sort.
  const workspaceRows = useMemo(() => {
    if (workspaceId === null || !workspaceDetail) return [] as SubshellView[];
    const byId = new Map(railRows.map((s) => [s.id, s] as const));
    const out: SubshellView[] = [];
    for (const pane of workspaceDetail.panes) {
      const s = byId.get(pane.subshellId);
      if (s) out.push(s);
    }
    return out;
  }, [workspaceId, workspaceDetail, railRows]);
  // The flat view's other half: everything the merged grid would show MINUS the
  // panes already listed under Workspace, so the two sections distinguish rather
  // than duplicate. Unused when no workspace is open (the grid stays whole and
  // headerless). Pane order and the four bands are still `flatCellRows`'s.
  const othersRows = useMemo(() => {
    if (workspaceRows.length === 0) return [] as SubshellView[];
    const workspaceIds = new Set(workspaceRows.map((s) => s.id));
    return flatRows.filter((s) => !workspaceIds.has(s.id));
  }, [flatRows, workspaceRows]);
  const workspaceCellLabels = (sub: SubshellView) => ({
    nodeLabel: machineLabel(sub),
    agentLabel: agentLabel(sub.harnessId),
    presetLabel: presetLabel(sub.presetId),
    initial: paneInitial(sub.name),
  });

  // One control folds or opens EVERY collapsible group in the rail at once
  // (operator ask 2026-09-27). "All collapsed" is measured over only the groups
  // that are PRESENT, so a machine with nothing to file, or comms/Workspace/Others
  // when there is none, never blocks the reading. While FILTERING the button is
  // inert exactly like the group headers it would act on: the filter has already
  // forced everything open, and a write now would reopen nothing visible yet shut
  // the rail the moment the filter clears.
  // Which sections CAN collapse in the CURRENT view, since the three modes
  // draw different headers: rows/cells draw the per-machine groups and the
  // comms section but no "Others"; cells-flat draws only Workspace and Others
  // over one merged grid. The measure and the writes are gated on exactly
  // this set, so the flat view never reads or saves an Others fold that has
  // no header on screen, and rows/cells never touch the prefs of sections
  // they do not draw (operator review 2026-09-27).
  const showsGroupedMachines = view !== "cells-flat";
  const showsComms = showsGroupedMachines && commsGroup.total > 0;
  const showsWorkspace = workspaceRows.length > 0;
  const showsOthers = view === "cells-flat" && othersRows.length > 0;
  const collapsibleGroupsExist =
    (showsGroupedMachines && nodeGroups.length > 0) || showsComms || showsWorkspace || showsOthers;
  const allCollapsed =
    (!showsGroupedMachines || nodeGroups.every((group) => collapsedGroups.includes(group.nodeId))) &&
    (!showsComms || !commsOpen) &&
    (!showsWorkspace || !workspaceOpen) &&
    (!showsOthers || !othersOpen);
  function toggleAllGroups() {
    const expand = allCollapsed; // all shut → open them; otherwise → shut them
    if (showsGroupedMachines) {
      setCollapsedGroups(setCollapsedNodeGroups(expand ? [] : nodeGroups.map((group) => group.nodeId)));
    }
    if (showsComms) setCommsOpen(setCommsGroupOpen(expand));
    if (showsWorkspace) setWorkspaceOpen(setWorkspaceGroupOpen(expand));
    if (showsOthers) setOthersOpen(setOthersGroupOpen(expand));
  }

  return (
    <>
      {/* The mode control sits where the filter box used to sit alone, and
          only in the expanded rail like everything in this section.
          `fill={false}`: the rail is narrow and the control is three icons,
          content-sized (design-system.md tab-group rule).
          `dense` is the vertical saving (operator correction 2026-09-25:
          "the buttons in the tabbed group, reduce the padding on them by
          half") — the buttons drop to h-6, the cell grid's own rhythm, and
          the fieldset keeps its p-0.5 border inset. The wrapper adds no
          padding of its own: the nav row's `py-2` already separates from
          above. The gap BELOW to the filter row is NOT the target. */}
      <div className="flex items-center gap-1 px-2">
        <Segmented<RailSubshellsView>
          ariaLabel="Subshell list view"
          fill={false}
          dense
          options={[
            {
              value: "rows",
              label: "",
              icon: <List className="h-4 w-4" />,
              ariaLabel: "Row view",
              tooltip: "List of subshells",
            },
            {
              value: "cells",
              label: "",
              icon: <LayoutGrid className="h-4 w-4" />,
              ariaLabel: "Cell view",
              tooltip: "Status cells, grouped by machine",
            },
            {
              value: "cells-flat",
              label: "",
              icon: <Grid3x3 className="h-4 w-4" />,
              ariaLabel: "Flat cell view",
              tooltip: "All status cells in one grid, most urgent first",
            },
          ]}
          value={view}
          onChange={changeView}
        />
        {/* Collapse/expand ALL groups in one press (operator ask 2026-09-27),
            riding the mode row's right edge. Inert while filtering, when the
            groups are force-open and their own chevrons are dead. */}
        <TippedIconButton
          tooltip={allCollapsed ? "Expand all groups" : "Collapse all groups"}
          variant="ghost"
          size="icon"
          disabled={q !== "" || !collapsibleGroupsExist}
          onClick={toggleAllGroups}
          className="ml-auto h-6 w-6 shrink-0 text-muted-foreground"
        >
          {allCollapsed ? <ChevronsUpDown className="h-3.5 w-3.5" /> : <ChevronsDownUp className="h-3.5 w-3.5" />}
        </TippedIconButton>
      </div>
      <div className="px-2 pt-1 pb-2">
        <Input
          ref={filterRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter subshells…"
          aria-label="Filter subshells"
          className="h-7 text-detail"
        />
      </div>
      {q !== "" && listedCount === 0 && <p className="px-3 py-1 text-detail text-muted-foreground">No matches.</p>}

      {view === "rows" && (
        <>
          {/* Topmost: the workspace you are standing in, collapsible like every
              other group (its own OPEN-by-default preference). Rows carry the
              machine as a third line, since the Workspace header spans hosts. */}
          {workspaceRows.length > 0 && (
            <div className="mb-1">
              <SubshellNodeGroup
                nodeId={WORKSPACE_GROUP_ID}
                label="Workspace"
                title="Workspace"
                count={workspaceRows.length}
                open={q !== "" || workspaceOpen}
                disabled={q !== ""}
                onToggle={toggleWorkspaceOpen}
              >
                {workspaceRows.map((sub) => (
                  <SubshellRecentRow
                    key={`ws-${sub.id}`}
                    subshell={sub}
                    selected
                    focused={focusedId === sub.id}
                    focusOnOpen={onWorkspace}
                    nodeLine={machineLabel(sub)}
                    nodeLabel={machineLabel(sub)}
                    agentLabel={agentLabel(sub.harnessId)}
                    presetLabel={presetLabel(sub.presetId)}
                  />
                ))}
              </SubshellNodeGroup>
            </div>
          )}
          {attentionRows.length > 0 && (
            <section aria-label="Needs Attention" className="mb-1">
              <div className="flex w-full items-center gap-2 py-1 pr-2 pl-3 text-detail text-muted-foreground">
                <span className="min-w-0 flex-1 truncate font-strong">Needs Attention</span>
                <span className="shrink-0 tabular-nums opacity-70">{attentionRows.length}</span>
              </div>
              {attentionRows.map((sub) => (
                <SubshellRecentRow
                  key={`attention-${sub.id}`}
                  subshell={sub}
                  selected={selectedIds.has(sub.id)}
                  focused={focusedId === sub.id}
                  focusOnOpen={onWorkspace && selectedIds.has(sub.id)}
                  nodeLabel={machineLabel(sub)}
                  agentLabel={agentLabel(sub.harnessId)}
                  presetLabel={presetLabel(sub.presetId)}
                />
              ))}
            </section>
          )}
          {/* The cross-agent comms section (operator ask 2026-09-25), ABOVE
              the machine groups since the operator ask of 2026-09-26, and
              only when there is something to file. It reuses the machine
              group's collapsing IDIOM but carries its own preference, because
              its default is the other way: closed. Each row's subline names
              its own machine (the section header cannot, it spans them
              all). */}
          {commsGroup.total > 0 && (
            <SubshellNodeGroup
              key={commsGroup.nodeId}
              nodeId={commsGroup.nodeId}
              label={commsGroup.label}
              title={commsGroup.title}
              count={commsGroup.total}
              open={q !== "" || commsOpen}
              disabled={q !== ""}
              onToggle={toggleCommsOpen}
            >
              {commsGroup.subshells.map((sub) => {
                const machine = machineLabel(sub);
                return (
                  <SubshellRecentRow
                    key={`comms-${sub.id}`}
                    subshell={sub}
                    selected={selectedIds.has(sub.id)}
                    focused={focusedId === sub.id}
                    focusOnOpen={onWorkspace && selectedIds.has(sub.id)}
                    nodeLabel={machine}
                    subline={machine}
                    agentLabel={agentLabel(sub.harnessId)}
                    presetLabel={presetLabel(sub.presetId)}
                  />
                );
              })}
            </SubshellNodeGroup>
          )}
          {orderedNodeGroups.map((group) => (
            <SubshellNodeGroup
              key={group.nodeId}
              nodeId={group.nodeId}
              label={group.label}
              title={group.title}
              count={group.total}
              // While filtering, every group is open whatever this device
              // remembers: a match hidden inside a shut group reads as a
              // filter that does not work. The header is INERT for the
              // duration rather than merely overridden — a live chevron here
              // would write the collapse to storage behind a screen that
              // moves nothing, and the group would shut itself the moment the
              // filter cleared.
              open={q !== "" || !collapsedGroups.includes(group.nodeId)}
              disabled={q !== ""}
              onToggle={() => toggleNodeGroupOpen(group.nodeId)}
            >
              {group.subshells.map((sub) => (
                <SubshellRecentRow
                  key={sub.id}
                  subshell={sub}
                  selected={selectedIds.has(sub.id)}
                  focused={focusedId === sub.id}
                  focusOnOpen={onWorkspace && selectedIds.has(sub.id)}
                  nodeLabel={group.label}
                  agentLabel={agentLabel(sub.harnessId)}
                  presetLabel={presetLabel(sub.presetId)}
                />
              ))}
            </SubshellNodeGroup>
          ))}
        </>
      )}

      {view === "cells" && (
        <>
          {/* Topmost: the workspace you are standing in (grouped cells), on the
              same collapsible group the machine cells sit in. */}
          {workspaceRows.length > 0 && (
            <div className="mb-1">
              <SubshellNodeGroup
                nodeId={WORKSPACE_GROUP_ID}
                label="Workspace"
                title="Workspace"
                count={workspaceRows.length}
                open={q !== "" || workspaceOpen}
                disabled={q !== ""}
                onToggle={toggleWorkspaceOpen}
              >
                <SubshellCellGrid
                  rows={workspaceRows}
                  selectedIds={selectedIds}
                  focusedId={focusedId}
                  focusOnClick={onWorkspace}
                  labelsFor={workspaceCellLabels}
                />
              </SubshellNodeGroup>
            </div>
          )}
          {attentionRows.length > 0 && (
            <section aria-label="Needs Attention" className="mb-1">
              <div className="flex w-full items-center gap-2 py-1 pr-2 pl-3 text-detail text-muted-foreground">
                <span className="min-w-0 flex-1 truncate font-strong">Needs Attention</span>
                <span className="shrink-0 tabular-nums opacity-70">{attentionRows.length}</span>
              </div>
              <SubshellCellGrid
                rows={attentionRows}
                selectedIds={selectedIds}
                focusedId={focusedId}
                focusOnClick={onWorkspace}
                labelsFor={(sub) => ({
                  nodeLabel: machineLabel(sub),
                  agentLabel: agentLabel(sub.harnessId),
                  presetLabel: presetLabel(sub.presetId),
                  initial: paneInitial(sub.name),
                })}
              />
            </section>
          )}
          {/* The comms section keeps its place above the machine groups in
              this mode too (operator ask 2026-09-26); grouped cells keeps it a
              headed section because its header carries the count. */}
          {commsGroup.total > 0 && (
            <SubshellNodeGroup
              key={commsGroup.nodeId}
              nodeId={commsGroup.nodeId}
              label={commsGroup.label}
              title={commsGroup.title}
              count={commsGroup.total}
              open={q !== "" || commsOpen}
              disabled={q !== ""}
              onToggle={toggleCommsOpen}
            >
              <SubshellCellGrid
                rows={commsGroup.subshells}
                selectedIds={selectedIds}
                focusedId={focusedId}
                focusOnClick={onWorkspace}
                labelsFor={(sub) => ({
                  // The comms header spans machines, so each cell's tooltip
                  // names its own (the rows say it in their subline).
                  nodeLabel: machineLabel(sub),
                  agentLabel: agentLabel(sub.harnessId),
                  presetLabel: presetLabel(sub.presetId),
                  initial: paneInitial(sub.name),
                })}
              />
            </SubshellNodeGroup>
          )}
          {orderedNodeGroups.map((group) => (
            <SubshellNodeGroup
              key={group.nodeId}
              nodeId={group.nodeId}
              label={group.label}
              title={group.title}
              count={group.total}
              open={q !== "" || !collapsedGroups.includes(group.nodeId)}
              disabled={q !== ""}
              onToggle={() => toggleNodeGroupOpen(group.nodeId)}
            >
              <SubshellCellGrid
                rows={group.subshells}
                selectedIds={selectedIds}
                focusedId={focusedId}
                focusOnClick={onWorkspace}
                labelsFor={(sub) => ({
                  // The group header already names the machine — same label,
                  // one source of truth for header and tooltip. The letter is
                  // the PANE's own (operator live review: grouped cells
                  // without letters were blank colour squares).
                  nodeLabel: group.label,
                  agentLabel: agentLabel(sub.harnessId),
                  presetLabel: presetLabel(sub.presetId),
                  initial: paneInitial(sub.name),
                })}
              />
            </SubshellNodeGroup>
          ))}
        </>
      )}

      {view === "cells-flat" &&
        (workspaceRows.length > 0 ? (
          <>
            {/* A workspace is open, so the flat grid splits into two labelled,
                collapsible halves: the panes you are working in, and everything
                else. These two sections appear ONLY now (operator ask
                2026-09-27) — with no workspace the view is the single
                headerless grid below. The halves exclude each other rather than
                duplicate, so "Others" really reads as the rest. */}
            <SubshellNodeGroup
              nodeId={WORKSPACE_GROUP_ID}
              label="Workspace"
              title="Workspace"
              count={workspaceRows.length}
              open={q !== "" || workspaceOpen}
              disabled={q !== ""}
              onToggle={toggleWorkspaceOpen}
            >
              <SubshellCellGrid
                rows={workspaceRows}
                selectedIds={selectedIds}
                focusedId={focusedId}
                focusOnClick={onWorkspace}
                labelsFor={workspaceCellLabels}
                tintOf={(sub) => nodeTintBucket(machineLabel(sub))}
              />
            </SubshellNodeGroup>
            {othersRows.length > 0 && (
              <SubshellNodeGroup
                nodeId={OTHERS_GROUP_ID}
                label="Others"
                title="Others"
                count={othersRows.length}
                open={q !== "" || othersOpen}
                disabled={q !== ""}
                onToggle={toggleOthersOpen}
              >
                <SubshellCellGrid
                  rows={othersRows}
                  selectedIds={selectedIds}
                  focusedId={focusedId}
                  focusOnClick={onWorkspace}
                  labelsFor={workspaceCellLabels}
                  tintOf={(sub) => nodeTintBucket(machineLabel(sub))}
                />
              </SubshellNodeGroup>
            )}
          </>
        ) : (
          <SubshellCellGrid
            rows={flatRows}
            selectedIds={selectedIds}
            focusedId={focusedId}
            focusOnClick={onWorkspace}
            labelsFor={(sub) => ({
              nodeLabel: machineLabel(sub),
              agentLabel: agentLabel(sub.harnessId),
              presetLabel: presetLabel(sub.presetId),
              // The machine reads from the plate + tooltip; the letter is the
              // pane's own, and a collision is expected, not a defect.
              initial: paneInitial(sub.name),
            })}
            tintOf={(sub) => nodeTintBucket(machineLabel(sub))}
          />
        ))}
    </>
  );
}
