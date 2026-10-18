import { apiFetch, cn, Input } from "@internal/node-admin";
import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { type JSX, type MouseEvent, useCallback, useState } from "react";
import { ListLoadError } from "@/components/list-load-error";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilteredList } from "@/hooks/use-filtered-list";
import { useWorkspaces, WORKSPACES_QUERY_KEY } from "@/hooks/use-workspaces";
import { workspaceIdFromPath } from "@/lib/route-ids";
import { RECENT_LIMIT } from "@/lib/sidebar-recents";
import { encodeSubshellDrag } from "@/lib/subshell-dnd";
import { requestWorkspacePaneFocus } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";
import type { WorkspacePaneRow, WorkspaceRow } from "@/types/workspace";

/** Query key for the Ungrouped branch read (exported for tests). */
export const UNGROUPED_QUERY_KEY = ["subshells", "workspace-none"] as const;

/**
 * The sidebar's Workspaces tree (spec 2026-10-17): each workspace row expands
 * to the panes it holds, and an Ungrouped section underneath lists the
 * subshells that live in no workspace — the drag source the whole model runs
 * on. This replaced the Saved/Drafts pair: a workspace exists exactly as long
 * as it holds a tab, so there is no unsaved half-list to sweep anymore, and
 * "what you're working on" and "what exists" stopped being two questions.
 *
 * The active workspace auto-expands (its branch is the one you want); others
 * open on the chevron and the choice persists per device. A search force-opens
 * every match, the same promise the machine groups make: a hit inside a folded
 * branch would read as a broken search.
 *
 * Rows are cheap here by design: the LIST carries every workspace's panes, so
 * the whole tree is this one query plus one for Ungrouped.
 */
const WS_EXPANDED_KEY = "subshell.sidebarWsExpanded";

/** Classes for a tree row inside the Workspaces branch. */
function branchClass(active: boolean): string {
  return cn(
    "my-1 block truncate rounded-md py-1 pr-3 pl-3 text-detail transition-colors",
    active
      ? "bg-accent font-strong text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );
}

/** The status dot a pane row wears: alive gold, waiting amber-ish, dead hollow. */
function PaneDot({ pane }: { pane: WorkspacePaneRow }): JSX.Element {
  const waiting = pane.subshellWaitingSince !== null;
  if (!pane.subshellAlive)
    return <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-current opacity-60" />;
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", waiting ? "bg-warning" : "bg-primary")} />;
}

/**
 * One pane row inside a workspace branch. Clicking focuses the dock when that
 * workspace is the page on screen (the event bus, no navigation at all) and
 * opens the workspace otherwise. The rail stays a pointer shortcut: everything
 * a pane can do lives on its header and its own page, and a menu here would be
 * the third copy of it.
 */
function PaneBranchRow({ pane, workspaceId }: { pane: WorkspacePaneRow; workspaceId: string }): JSX.Element {
  const navigate = useNavigate();
  function onClick(e: MouseEvent): void {
    e.preventDefault();
    if (requestWorkspacePaneFocus(pane.subshellId)) return;
    void navigate({ to: "/workspaces/$id", params: { id: workspaceId } });
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(branchClass(false), "ml-4 flex w-[calc(100%-1rem)] items-center gap-2 text-left")}
      title={`${pane.subshellName} — ${pane.workingDir}`}
    >
      <PaneDot pane={pane} />
      <span className="min-w-0 flex-1 truncate">{pane.subshellName}</span>
    </button>
  );
}

/**
 * A subshell that lives in no workspace of the caller's. Draggable with the
 * same payload the dock and the workspace cards already accept, so "add this
 * to a workspace" is drag-onto-the-page, and the keyboard equivalent is the
 * workspace's own Add-subshell picker.
 */
function UngroupedRow({ subshell }: { subshell: SubshellView }): JSX.Element {
  const navigate = useNavigate();
  return (
    <Link
      to="/subshells/$id"
      params={{ id: subshell.id }}
      draggable
      onDragStart={(e) => encodeSubshellDrag(e.dataTransfer, subshell.id)}
      onClick={() => void navigate({ to: "/subshells/$id", params: { id: subshell.id } })}
      className={cn(branchClass(false), "ml-4 flex w-[calc(100%-1rem)] cursor-grab items-center gap-2")}
      title={`${subshell.name}: drag onto a workspace, or click to open`}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          subshell.alive ? "bg-primary" : "border border-current opacity-60",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{subshell.name}</span>
    </Link>
  );
}

/** A collapsible branch header for one workspace, with its expand chevron. */
function WorkspaceBranch({
  workspace,
  expanded,
  active,
  forceOpen,
  onToggle,
}: {
  workspace: WorkspaceRow;
  expanded: boolean;
  active: boolean;
  forceOpen: boolean;
  onToggle: () => void;
}): JSX.Element {
  const open = expanded || forceOpen;
  return (
    <div>
      {/* The accent fill belongs to the WHOLE row, not just the name link: the
        count and the chevron sit inside the highlighted bar too, or the active
        workspace reads as a name with two unselected strays beside it (operator
        note, 2026-10-17). The fill lives here; `branchClass` supplies the shape
        minus the colour it carries. */}
      <div
        className={cn(
          "flex w-full items-center gap-0.5 rounded-md pr-1",
          active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
        )}
      >
        <Link
          to="/workspaces/$id"
          params={{ id: workspace.id }}
          className={cn(
            "my-1 min-w-0 flex-1 truncate rounded-md py-1 pr-3 pl-3 text-detail transition-colors",
            active ? "font-strong" : "hover:bg-accent/50 hover:text-foreground",
          )}
        >
          {workspace.name}
        </Link>
        <span className="shrink-0 text-detail tabular-nums opacity-60">{workspace.subshellCount}</span>
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? `Collapse ${workspace.name}` : `Expand ${workspace.name}`}
          aria-expanded={open}
          className="shrink-0 rounded p-0.5 hover:text-foreground"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", !open && "-rotate-90")} />
        </button>
      </div>
      {open && (
        <div>
          {(workspace.panes ?? []).map((pane) => (
            <PaneBranchRow key={pane.id} pane={pane} workspaceId={workspace.id} />
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
  const ungrouped = useQuery({
    queryKey: UNGROUPED_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<SubshellView[]>("/api/subshells?workspace=none", { signal }),
    staleTime: 30_000,
  });

  // Recency first (the old "Saved" order), capped when not searching; every
  // name match while searching, uncapped.
  const source = search ? (results.data ?? []) : (workspaces ?? []);
  const sorted = [...source].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = search ? sorted : sorted.slice(0, RECENT_LIMIT);

  const activeId = workspaceIdFromPath(location.pathname);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(WS_EXPANDED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = { ...prev };
      // Persist the DEVIATION from default (only the active row is open by
      // default): a stored true means "user opened it", a stored false means
      // "user closed it". Both are one key; the default is neither.
      if (next[id]) next[id] = false;
      else next[id] = true;
      try {
        localStorage.setItem(WS_EXPANDED_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable — the fold still works this session
      }
      return next;
    });
  }, []);

  const ungroupedRows = (ungrouped.data ?? []).slice(0, search ? 200 : RECENT_LIMIT);
  const nothingAtAll = !isLoading && (workspaces?.length ?? 0) === 0 && (ungrouped.data?.length ?? 0) === 0 && !search;
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
            expanded={w.id === activeId || expanded[w.id] === true}
            forceOpen={search !== "" && (results.data ?? workspaces ?? []).some((r) => r.id === w.id)}
            onToggle={() => toggle(w.id)}
          />
        </WorkspaceActionsMenu>
      ))}
      {ungroupedRows.length > 0 && (
        <div className="mt-2">
          <p className="px-3 pb-0.5 font-strong text-detail text-muted-foreground uppercase opacity-70">Ungrouped</p>
          {ungroupedRows.map((s) => (
            <UngroupedRow key={s.id} subshell={s} />
          ))}
        </div>
      )}
      {isError && <ListLoadError message="Couldn’t load workspaces." retry={refetch} busy={isLoading} />}
      {isLoading && <p className="px-3 py-1 text-detail text-muted-foreground">Loading…</p>}
      {search && !isLoading && !results.isLoading && shown.length === 0 && ungroupedRows.length === 0 && (
        <p className="px-3 py-1 text-detail text-muted-foreground">No workspaces or panes match.</p>
      )}
    </div>
  );
}
