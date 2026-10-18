import { cn, Input } from "@internal/node-admin";
import { LIST_SEARCH_MAX } from "@internal/subshell-protocol";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { type JSX, type MouseEvent, useCallback, useState } from "react";
import { ListLoadError } from "@/components/list-load-error";
import { SubshellDot } from "@/components/subshell-dot";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilteredList } from "@/hooks/use-filtered-list";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { useWorkspaces, WORKSPACES_QUERY_KEY } from "@/hooks/use-workspaces";
import { workspaceIdFromPath } from "@/lib/route-ids";
import { RECENT_LIMIT } from "@/lib/sidebar-recents";
import { requestWorkspacePaneFocus } from "@/lib/workspace-focus";
import type { WorkspacePaneRow, WorkspaceRow } from "@/types/workspace";

/**
 * The sidebar's Workspaces tree (spec 2026-10-17): each workspace row expands
 * to the panes it holds. This replaced the Saved/Drafts pair: a workspace
 * exists exactly as long as it holds a tab, so there is no unsaved half-list
 * to sweep anymore, and "what you're working on" and "what exists" stopped
 * being two questions. Panes that live in no workspace are deliberately
 * absent here (operator ruling, 2026-10-17): the tree is about workspaces,
 * and an unfiled session is already visible in the subshells list's machine
 * groups — clicking one there builds a workspace around it.
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

/** Classes for a tree row inside the Workspaces branch. */
function branchClass(active: boolean): string {
  return cn(
    "my-1 block truncate rounded-md py-1 pr-3 pl-3 text-detail transition-colors",
    active
      ? "bg-accent font-strong text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );
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
  // The same shared dot every other surface draws (working blink, quiet
  // green, waiting, offline, dead) — a second, coarser spelling of "is this
  // pane alive" in the tree was the operator's complaint of 2026-10-17:
  // every mark in the rail means the same thing or the rail lies. Reads the
  // live list cache, so it needs no extra request; no row yet (the list is
  // still loading) draws a placeholder, not a guess.
  const subshell = useSubshellRow(pane.subshellId);
  function onClick(e: MouseEvent): void {
    e.preventDefault();
    if (requestWorkspacePaneFocus(pane.subshellId)) return;
    void navigate({ to: "/workspaces/$id", params: { id: workspaceId } });
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(branchClass(false), "ml-4 block w-[calc(100%-1rem)] text-left")}
      title={`${pane.subshellName}: ${pane.workingDir}`}
    >
      <span className="flex items-center gap-2">
        {subshell ? (
          <SubshellDot subshell={subshell} className="h-1.5 w-1.5 shrink-0" />
        ) : (
          <span aria-hidden className="size-1.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{pane.subshellName}</span>
      </span>
      {/* The directory under the name, muted by colour and weight — the
          line-items rule (label over detail), and the same fact the rail
          rows carry, so a workspace of two shells says WHICH two. */}
      <span className="block truncate pl-[14px] text-muted-foreground opacity-80">{pane.workingDir}</span>
    </button>
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
        count and the chevron sit inside the highlighted bar too, or the row
        reads as a name with two unselected strays beside it (operator note,
        2026-10-17). That is true of HOVER exactly as of the active state, so
        both fills — and the colour transition — live on this container; a
        hover that painted only the link stopped the bar dead before the count
        (same note, later the same day). */}
      <div
        className={cn(
          "flex w-full items-center gap-0.5 rounded-md pr-1 transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <Link
          to="/workspaces/$id"
          params={{ id: workspace.id }}
          className={cn("my-1 min-w-0 flex-1 truncate rounded-md py-1 pr-3 pl-3 text-detail", active && "font-strong")}
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

  const nothingAtAll = !isLoading && (workspaces?.length ?? 0) === 0 && !search;
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
      {isError && <ListLoadError message="Couldn’t load workspaces." retry={refetch} busy={isLoading} />}
      {isLoading && <p className="px-3 py-1 text-detail text-muted-foreground">Loading…</p>}
      {search && !isLoading && !results.isLoading && shown.length === 0 && (
        <p className="px-3 py-1 text-detail text-muted-foreground">No workspaces match.</p>
      )}
    </div>
  );
}
