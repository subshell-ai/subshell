import { Input } from "@internal/node-admin";
import { useLocation } from "@tanstack/react-router";
import { Grid3x3, LayoutGrid, List } from "lucide-react";
import { type RefObject, useCallback, useState } from "react";
import { SubshellNodeGroup } from "@/components/sidebar/SubshellNodeGroup";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { flatCellRows, nodeTintBucket, paneInitial, SubshellCellGrid } from "@/components/sidebar/subshell-cell-grid";
import { Segmented } from "@/components/ui/segmented";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { usePresets } from "@/hooks/use-presets";
import {
  collapsedNodeGroups,
  commsGroupOpen,
  setCollapsedNodeGroups,
  setCommsGroupOpen,
  toggleNodeGroup,
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
import type { SubshellView } from "@/types/subshell";

/**
 * The rail's whole subshell section: the mode control, the filter box, the
 * Needs Attention spotlight, the machine groups and the Cross-agent comms
 * section, in one of THREE renderings behind a single choice.
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
  // one section of their own below the machines, each row naming the machine
  // it runs on since the section spans them. The partition runs on the
  // FILTERED list, so a search matches them exactly like a machine's rows.
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
  // the caps are off, so it holds exactly these rows (deduped).
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
  // The flat grid's cell set, clustered by machine label — the SAME key the
  // plate tint hashes, so a run of equal tints is exactly one machine's
  // cells. Recomputed per render like the grouping itself: it is the
  // grouping's own output re-sorted, so the two modes cannot disagree about
  // which panes are on screen.
  const flatRows = flatCellRows(nodeGroups, commsGroup.subshells, attentionRows, machineLabel);

  // The open subshell's cell ring. Rows compare per row (their own line of
  // JSX); the grid takes one id, derived the same way from the same pathname.
  const activeId = location.pathname.startsWith("/subshells/") ? location.pathname.slice("/subshells/".length) : null;

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
      <div className="px-2">
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
                  active={location.pathname === `/subshells/${sub.id}`}
                  nodeLabel={machineLabel(sub)}
                  agentLabel={agentLabel(sub.harnessId)}
                  presetLabel={presetLabel(sub.presetId)}
                />
              ))}
            </section>
          )}
          {nodeGroups.map((group) => (
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
                  active={location.pathname === `/subshells/${sub.id}`}
                  nodeLabel={group.label}
                  agentLabel={agentLabel(sub.harnessId)}
                  presetLabel={presetLabel(sub.presetId)}
                />
              ))}
            </SubshellNodeGroup>
          ))}
          {/* The cross-agent comms section (operator ask 2026-09-25), below
              the machines and only when there is something to file. It
              reuses the machine group's collapsing IDIOM but carries its own
              preference, because its default is the other way: closed. Each
              row's subline names its own machine (the section header cannot,
              it spans them all). */}
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
                    active={location.pathname === `/subshells/${sub.id}`}
                    nodeLabel={machine}
                    subline={machine}
                    agentLabel={agentLabel(sub.harnessId)}
                    presetLabel={presetLabel(sub.presetId)}
                  />
                );
              })}
            </SubshellNodeGroup>
          )}
        </>
      )}

      {view === "cells" && (
        <>
          {attentionRows.length > 0 && (
            <section aria-label="Needs Attention" className="mb-1">
              <div className="flex w-full items-center gap-2 py-1 pr-2 pl-3 text-detail text-muted-foreground">
                <span className="min-w-0 flex-1 truncate font-strong">Needs Attention</span>
                <span className="shrink-0 tabular-nums opacity-70">{attentionRows.length}</span>
              </div>
              <SubshellCellGrid
                rows={attentionRows}
                activeId={activeId}
                labelsFor={(sub) => ({
                  nodeLabel: machineLabel(sub),
                  agentLabel: agentLabel(sub.harnessId),
                  presetLabel: presetLabel(sub.presetId),
                  initial: paneInitial(sub.name),
                })}
              />
            </section>
          )}
          {nodeGroups.map((group) => (
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
                activeId={activeId}
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
                activeId={activeId}
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
        </>
      )}

      {view === "cells-flat" && (
        <SubshellCellGrid
          rows={flatRows}
          activeId={activeId}
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
      )}
    </>
  );
}
