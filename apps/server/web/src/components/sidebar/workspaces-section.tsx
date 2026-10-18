import { cn, ExplainedButton, errMessage, Input } from "@internal/node-admin";
import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { type DragEvent, type JSX, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ListLoadError } from "@/components/list-load-error";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilteredList } from "@/hooks/use-filtered-list";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { usePresets } from "@/hooks/use-presets";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { useWorkspacePaneMutations } from "@/hooks/use-workspace-pane-mutations";
import { useWorkspaces, WORKSPACES_QUERY_KEY } from "@/hooks/use-workspaces";
import { workspaceIdFromPath } from "@/lib/route-ids";
import { readSubshellDrag, SUBSHELL_DND_TYPE } from "@/lib/subshell-dnd";
import { FALLBACK_NODE_ID, nodeLabelFor } from "@/lib/subshell-node-groups";
import { useWorkspaceFocusedId } from "@/lib/workspace-focus";
import { railWorkspaceRows } from "@/lib/workspace-rail";
import type { SubshellView } from "@/types/subshell";
import type { WorkspacePaneRow, WorkspaceRow } from "@/types/workspace";

/**
 * The sidebar's Workspaces tree (spec 2026-10-17): each workspace row expands
 * to the panes it holds. This replaced the Saved/Drafts pair: a workspace
 * exists exactly as long as it holds a tab, so there is no unsaved half-list
 * to sweep anymore, and "what you're working on" and "what exists" stopped
 * being two questions. Panes that live in no workspace are deliberately
 * absent here (operator ruling, 2026-10-17): the tree is about workspaces,
 * and an unfiled session is already visible in the subshells list's machine
 * groups — clicking one there files it into an existing workspace, and any
 * row in this tree takes a drop.
 *
 * The active workspace auto-expands (its branch is the one you want); others
 * open on the chevron and the choice persists per device. A search force-opens
 * every match, the same promise the machine groups make: a hit inside a folded
 * branch would read as a broken search.
 *
 * Rows are cheap here by design: the LIST carries every workspace's panes, so
 * the whole tree is this one query.
 */
const WS_EXPANDED_KEY = "subshell.sidebarWsExpanded";

/** The tooltip labels one pane row, resolved from the lists the rail holds. */
interface RowLabels {
  nodeLabel: string;
  agentLabel: string;
  presetLabel?: string;
}

/**
 * One pane row inside a workspace branch: THE rail's `SubshellRecentRow`, the
 * same component the subshells section draws (operator ruling, 2026-10-17:
 * two components rendering "a subshell in the sidebar" is how they drift).
 * The branch adds its semantics through props: `branchWorkspaceId` aims the
 * click at THIS workspace's tab, and the one row marked is the dock's
 * focused pane while this branch is the page on screen.
 */
function PaneBranchRow({
  pane,
  workspaceId,
  focused,
  labelsFor,
}: {
  pane: WorkspacePaneRow;
  workspaceId: string;
  /** The pane the dock has focused, while this branch is the page on screen
   * (the CALLER gates this on the branch being active). */
  focused: boolean;
  /** The caller-resolved tooltip labels, same ladder the machine rows use. */
  labelsFor: (sub: SubshellView) => RowLabels;
}): JSX.Element {
  // The full entity comes from the live list cache — the shared dot, the menu
  // and the tooltip all need the fields the pane row (id/name/dir) lacks. No
  // row yet (the list is still loading) paints the pane facts the workspace
  // LIST carries, in the same shape and at the same position, so the real
  // row lands without a jump.
  const subshell = useSubshellRow(pane.subshellId);
  if (!subshell) {
    return (
      <div className="my-1.5 flex items-start gap-2 rounded-md py-1 pr-3 pl-3 text-detail text-muted-foreground opacity-70">
        <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{pane.subshellName}</span>
          <span className="block truncate text-detail opacity-70">{pane.workingDir}</span>
        </span>
      </div>
    );
  }
  const labels = labelsFor(subshell);
  return (
    <SubshellRecentRow
      subshell={subshell}
      focused={focused}
      branchWorkspaceId={workspaceId}
      nodeLabel={labels.nodeLabel}
      agentLabel={labels.agentLabel}
      presetLabel={labels.presetLabel}
    />
  );
}

/** A collapsible branch header for one workspace, with its expand chevron. */
function WorkspaceBranch({
  workspace,
  expanded,
  active,
  forceOpen,
  onToggle,
  focusedId,
  labelsFor,
}: {
  workspace: WorkspaceRow;
  expanded: boolean;
  active: boolean;
  forceOpen: boolean;
  onToggle: () => void;
  /** The dock's focused pane on this page, when this branch IS the page. */
  focusedId: string | null;
  /** Per-row tooltip labels, resolved from the lists the rail holds. */
  labelsFor: (sub: SubshellView) => RowLabels;
}): JSX.Element {
  const open = expanded || forceOpen;
  // The branch is a DROP TARGET: dragging a session from the subshells list
  // onto its row files it here — the same idempotent pane-add the dock's
  // drop and the add-dialog use, so every "put this pane in that workspace"
  // gesture lands on one server path (operator ask, 2026-10-17: the dock was
  // not always on screen to receive the drop, and nothing said the sidebar
  // row could take it). The hint speaks the dock's dashed-ring idiom.
  const [dropHint, setDropHint] = useState(false);
  // dragenter/dragleave fire on every child the pointer crosses; only the
  // depth-zero exit means the drag actually left the branch.
  const dragDepth = useRef(0);
  const { addPane } = useWorkspacePaneMutations(workspace.id);

  const accepts = (dt: Pick<DataTransfer, "types">): boolean => Array.from(dt.types).includes(SUBSHELL_DND_TYPE);

  function onDragOver(e: DragEvent): void {
    // Without a preventDefault here the browser never fires `drop`, and a
    // file drag or dockview's tab drag must stay untouched (one MIME rule).
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragEnter(e: DragEvent): void {
    if (!accepts(e.dataTransfer)) return;
    dragDepth.current += 1;
    setDropHint(true);
  }

  function onDragLeave(): void {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropHint(false);
  }

  async function onDrop(e: DragEvent): Promise<void> {
    const subshellId = readSubshellDrag(e.dataTransfer);
    if (subshellId === null) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropHint(false);
    // `addPane` belongs to the pane-mutation seam, which wakes every
    // membership reader (tree LIST, open dock, subshell page) on success —
    // this handler only reports the failure.
    try {
      await addPane(subshellId);
    } catch (err) {
      toast.error(errMessage(err, "Could not add that subshell to the workspace."));
    }
  }

  return (
    // An HTML5 DROP target, not a click handler: drag events carry no tap or
    // keyboard semantics to lose, and the reachable equivalent of filing a
    // pane into a workspace is that workspace's Add-subshell dialog (same
    // precedent as the dock's drop overlay).
    // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drop target
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        void onDrop(e);
      }}
      className={cn("rounded-md transition-shadow", dropHint && "border-2 border-primary/60 border-dashed")}
    >
      {/* The accent fill belongs to the WHOLE row, not just the name link: the
        count and the chevron sit inside the highlighted bar too, or the row
        reads as a name with two unselected strays beside it (operator note,
        2026-10-17). That is true of HOVER exactly as of the active state, so
        both fills — and the colour transition — live on this container; a
        hover that painted only the link stopped the bar dead before the count
        (same note, later the same day). */}
      {/* The header wears the machine group header's shape (operator ask,
        2026-10-17, matching `SubshellNodeGroup`): one padded bar, bold label,
        count at /70, the chevron at the shared 8px rhythm. The accent fill on
        the active branch is the ONE extra signal a workspace needs (the
        machine group has no page to be standing in), and the fill covers the
        whole bar - count and chevron inside it (operator note, 2026-10-17). */}
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-3 text-detail transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
        )}
      >
        <Link to="/workspaces/$id" params={{ id: workspace.id }} className="min-w-0 flex-1 truncate font-strong">
          {workspace.name}
        </Link>
        {dropHint ? (
          // The affordance the drag was missing: this row is where a session
          // gets filed, and it says so only while one is being dragged.
          <span className="shrink-0 text-primary">Add to workspace</span>
        ) : (
          <span className="shrink-0 tabular-nums opacity-70">{workspace.subshellCount}</span>
        )}
        {/* Inert while the search force-opens this branch (the machine group's
          rule, copied): a press would move nothing visible, and a press that
          also wrote its state would fold the branch the moment the filter
          clears — a choice the user never saw themselves make. */}
        <ExplainedButton
          type="button"
          onClick={onToggle}
          disabled={forceOpen}
          disabledReason="Clear the filter to collapse this workspace."
          aria-label={open ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
          aria-expanded={open}
          className="shrink-0"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", !open && "-rotate-90")} />
        </ExplainedButton>
      </div>
      {open && (
        <div>
          {(workspace.panes ?? []).map((pane) => (
            <PaneBranchRow
              key={pane.id}
              pane={pane}
              workspaceId={workspace.id}
              focused={active && focusedId === pane.subshellId}
              labelsFor={labelsFor}
            />
          ))}
          {workspace.subshellCount === 0 && (
            <p className="ml-6 py-0.5 text-detail text-muted-foreground opacity-70">No tabs yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspacesSection(): JSX.Element | null {
  const location = useLocation();
  const { data: workspaces, isLoading, isError, refetch } = useWorkspaces();
  // Search state lives in one place the Input below drives; `useDebouncedValue`
  // gives the server read its pace.
  const [query, setQuery] = useState("");
  const search = query.trim();
  const debounced = useDebouncedValue(search);
  const results = useFilteredList<WorkspaceRow[]>(WORKSPACES_QUERY_KEY, "/api/workspaces", { q: debounced });

  // Recency first (the old "Saved" order), capped when not searching; every
  // name match while searching, uncapped — and the cap never drops the
  // branch that auto-expands, which is the one the page is standing in.
  const source = search ? (results.data ?? []) : (workspaces ?? []);
  const sorted = [...source].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const activeId = workspaceIdFromPath(location.pathname);
  const shown = railWorkspaceRows(sorted, { capped: !search, activeId });
  // The rows' tooltip labels, resolved HERE rather than per row, copying the
  // machine groups' ladder: all three lists are ones the rail already holds
  // elsewhere, so inside one tree these reads are cache hits, not requests.
  const { data: nodeData } = useNodes();
  const { data: pluginData } = useInstancePlugins();
  const { data: presetData } = usePresets();
  const focusedId = useWorkspaceFocusedId();
  const labelsFor = useCallback(
    (sub: SubshellView): RowLabels => ({
      nodeLabel: nodeLabelFor(sub.nodeId || FALLBACK_NODE_ID, nodeData?.nodes, nodeData === undefined).label,
      agentLabel: pluginData?.plugins.find((p) => p.id === sub.harnessId)?.name ?? sub.harnessId,
      presetLabel:
        sub.presetId == null ? undefined : (presetData?.find((p) => p.id === sub.presetId)?.name ?? sub.presetId),
    }),
    [nodeData, pluginData, presetData],
  );

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(WS_EXPANDED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  // One open-state resolver for every branch: the stored choice when there is
  // one, else the default (the active branch opens itself; the rest rest
  // closed). Reading it this way is what makes the ACTIVE branch collapsible
  // (operator bug, 2026-10-17): the old code OR-ed `w.id === activeId` on top
  // of the stored value, so a stored `false` — the user's own collapse — lost
  // to the auto-open and the chevron closed nothing.
  const isOpen = useCallback(
    (id: string): boolean => {
      const stored = expanded[id];
      return stored === undefined ? id === activeId : stored;
    },
    [expanded, activeId],
  );
  const toggle = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        // Flip against the CURRENT answer (stored choice or default), so the
        // first chevron press on the auto-opened active branch closes it.
        const currentlyOpen = prev[id] === undefined ? id === activeId : prev[id];
        const next = { ...prev, [id]: !currentlyOpen };
        try {
          localStorage.setItem(WS_EXPANDED_KEY, JSON.stringify(next));
        } catch {
          // storage unavailable — the fold still works this session
        }
        return next;
      });
    },
    [activeId],
  );

  // A failed read is NOT "nothing at all": hiding the section would swallow
  // the ListLoadError below (its `isError` arm is why it exists), and a rail
  // that silently loses the Workspaces tree reads as an empty instance
  // (review 2026-10-17). Only a settled, successful, genuinely empty list —
  // with no search typed — hides the section.
  const nothingAtAll = !isLoading && !isError && (workspaces?.length ?? 0) === 0 && !search;
  if (nothingAtAll) return null;

  return (
    <div className="mt-1.5">
      <div className="px-2 pt-1 pb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter workspaces…"
          maxLength={LIST_SEARCH_MAX.workspaces}
          aria-label="Filter workspaces"
          className="h-7 text-detail"
        />
      </div>
      {shown.map((w) => (
        <WorkspaceActionsMenu key={w.id} workspace={w}>
          <WorkspaceBranch
            workspace={w}
            active={w.id === activeId}
            expanded={isOpen(w.id)}
            forceOpen={search !== "" && (results.data ?? workspaces ?? []).some((r) => r.id === w.id)}
            onToggle={() => toggle(w.id)}
            focusedId={focusedId}
            labelsFor={labelsFor}
          />
        </WorkspaceActionsMenu>
      ))}
      {/* A failed SEARCH is an error, not an empty match: the old copy
        announced "No workspaces match." for a request that never answered,
        and offered no retry (the dashboard rule keeps loading, errors, and
        zero matches distinct). While searching, the filtered read is the one
        on screen, so its failure owns the Retry. */}
      {(isError || (search !== "" && results.isError)) && (
        <ListLoadError
          message="Couldn’t load workspaces."
          retry={search !== "" && results.isError ? results.refetch : refetch}
          busy={isLoading || (search !== "" && results.isLoading)}
        />
      )}
      {/* The search read has its own loading state; while it is in flight the
        tree is blank, and a blank tree with no signal reads as a broken
        filter (the machine groups' `rail-subshells` shows the same line). */}
      {(isLoading || (search !== "" && results.isLoading)) && (
        <p className="px-3 py-1 text-detail text-muted-foreground">Loading…</p>
      )}
      {search && !isLoading && !results.isLoading && !results.isError && shown.length === 0 && (
        <p className="px-3 py-1 text-detail text-muted-foreground">No workspaces match.</p>
      )}
    </div>
  );
}
