import { apiFetch, cn, confirmAction, errMessage, Input } from "@internal/node-admin";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, Trash2 } from "lucide-react";
import { type JSX, type ReactNode, useCallback, useState } from "react";
import { TippedIconButton } from "@/components/tipped-icon-button";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useDraftWorkspaces, useInvalidateWorkspaces, useWorkspaces } from "@/hooks/use-workspaces";
import { workspaceIdFromPath } from "@/lib/route-ids";
import { RECENT_LIMIT } from "@/lib/sidebar-recents";
import { formatWorkspaceDate } from "@/lib/workspace-name";

/**
 * Which Workspaces sub-sections (Saved / Drafts) are FOLDED, per device (a JSON
 * object of `{ [id]: true }`). Open by default, so only the shut ones store — the
 * same "absent means open" shape as `collapsedNodeGroups`. A long Drafts list can
 * fold away so the rest of the rail stays reachable.
 */
const WS_COLLAPSED_KEY = "subshell.sidebarWsGroupsCollapsed";

/** Classes for a "recent" sub-link: a compact row under its nav item. */
function recentClass(active: boolean): string {
  // Mirrors the subshell rail row (`SubshellRecentRow`) so the two read as the
  // same control: the pill spans the rail's left padding, the ACTIVE one takes
  // the same soft accent FILL, and the label sits just inside it. The old
  // `pl-10` + no fill made a workspace row look like a centered word floating in
  // empty space rather than a row like its subshell siblings (operator design
  // review 2026-09-27).
  return cn(
    "my-1.5 block truncate rounded-md py-1 pr-3 pl-3 text-detail transition-colors",
    active
      ? "bg-accent font-strong text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
  );
}

/**
 * A collapsible group inside the Workspaces list (Saved / Drafts): a header that
 * folds its rows behind a chevron, the rail's one collapsing idiom. The optional
 * `action` (the Drafts trashcan) sits OUTSIDE the toggle button, so the two are
 * never a button inside a button. `aria-controls` carries its own `ws-group-`
 * prefix, not the rail's `sidebar-node-group-`, so a Workspaces header is never
 * read as a machine group.
 *
 * `disabled` is the rail's inert-while-filtering half of that idiom: while a
 * search force-opens the section, a fold press would show nothing (the force
 * wins on screen) yet persist a choice the user never saw make, landing the
 * moment the query clears. So the button carries `disabled` and writes nothing.
 */
function WsSection({
  id,
  label,
  count,
  collapsed,
  disabled,
  onToggle,
  action,
  children,
}: {
  id: string;
  label: string;
  count?: number;
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const listId = `ws-group-${id}`;
  return (
    <div>
      <div className="flex w-full items-center gap-1 pr-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={listId}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-2 pl-3 text-detail text-muted-foreground transition-colors",
            disabled ? "cursor-default" : "cursor-pointer hover:text-accent-foreground",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left font-strong">{label}</span>
          {typeof count === "number" && <span className="shrink-0 tabular-nums opacity-70">{count}</span>}
          <ChevronDown
            className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", collapsed && "-rotate-90")}
          />
        </button>
        {action}
      </div>
      <div id={listId} className={cn(collapsed && "hidden")}>
        {children}
      </div>
    </div>
  );
}

/**
 * The sidebar's Workspaces section: a search box over two collapsible groups —
 * **Saved** (the eight most-recently-touched saved workspaces, or every name
 * match while searching) and **Drafts** (every unsaved workspace, labelled by its
 * creation stamp so it reads like a saved sibling). The draft you are standing in
 * highlights; a trashcan in the Drafts header discards the others (or all of them
 * when you are on a saved/home view), sparing the one in view.
 *
 * The drafts are a SEPARATE read (`?drafts=only`) so the Workspaces PAGE keeps
 * its saved-only list. This whole concern lives here rather than inline in
 * `AppSidebar`, which was already large and is a nav orchestrator.
 */
export function WorkspacesSection(): JSX.Element | null {
  const location = useLocation();
  const { data: workspaces } = useWorkspaces();
  const { data: draftWorkspaces } = useDraftWorkspaces();
  const invalidateWorkspaces = useInvalidateWorkspaces();

  // Search held here; it filters the WHOLE list uncapped — the same promise the
  // subshell rail's filter makes — so a search never hides a hit below the eight
  // it would otherwise list.
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const workspaceSearch = workspaceQuery.trim().toLowerCase();
  const sortedWorkspaces = (workspaces ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shownWorkspaces = workspaceSearch
    ? sortedWorkspaces.filter((w) => w.name.toLowerCase().includes(workspaceSearch))
    : sortedWorkspaces.slice(0, RECENT_LIMIT);

  // The active workspace id (from the URL) — only a DRAFT among these is the one
  // to spare from the discard sweep and to highlight. A SAVED active id must not
  // be treated as a spared draft, else the trashcan copy would promise a saved
  // workspace "stays" while it is in fact not one of the drafts at all.
  const activeWorkspaceId = workspaceIdFromPath(location.pathname);

  // Drafts, labelled by creation stamp. A stamp is minute-granular, so two drafts
  // made in one minute would be indistinguishable; when the label repeats, the
  // stored name (which for a split is the subshell's) is appended to tell them
  // apart. The search filters on that resolved label.
  const sortedDrafts = (draftWorkspaces ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const labelCounts = new Map<string, number>();
  const labeledDrafts = sortedDrafts.map((w) => {
    const base = formatWorkspaceDate(w.createdAt);
    const n = (labelCounts.get(base) ?? 0) + 1;
    labelCounts.set(base, n);
    return { row: w, label: n === 1 ? base : `${base} · ${w.name}` };
  });
  const shownDrafts = workspaceSearch
    ? labeledDrafts.filter((e) => e.label.toLowerCase().includes(workspaceSearch))
    : labeledDrafts;
  const activeIsDraft = activeWorkspaceId !== null && sortedDrafts.some((w) => w.id === activeWorkspaceId);
  const showDraftSection = shownDrafts.length > 0;

  // Which sub-sections are folded, per device (open by default). A search forces
  // every section open, exactly like the rail's filter overriding a shut group —
  // a match inside a folded section would otherwise read as a broken search.
  const [collapsedWs, setCollapsedWs] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(WS_COLLAPSED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const toggleWsSection = useCallback((id: string) => {
    setCollapsedWs((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      try {
        localStorage.setItem(WS_COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable — the fold still works this session
      }
      return next;
    });
  }, []);
  const isCollapsed = (id: string) => (workspaceSearch ? false : collapsedWs[id] === true);

  const [wsActionError, setWsActionError] = useState<string | null>(null);

  async function discardOtherDrafts() {
    setWsActionError(null);
    const ok = await confirmAction({
      title: activeIsDraft ? "Discard your other unsaved workspaces?" : "Discard your unsaved workspaces?",
      description: activeIsDraft
        ? "Your other unsaved workspaces will be removed. The one you're in stays."
        : "Your unsaved workspaces will be removed.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    try {
      // Spare the active workspace ONLY when it is itself a draft; a saved or
      // foreign id is not one of the drafts the sweep targets anyway, and naming
      // it would falsely promise it "stays".
      const except = activeIsDraft ? activeWorkspaceId : null;
      await apiFetch(`/api/workspaces/drafts${except ? `?except=${encodeURIComponent(except)}` : ""}`, {
        method: "DELETE",
      });
    } catch (err) {
      setWsActionError(errMessage(err, "Failed to discard"));
      return;
    }
    await invalidateWorkspaces();
  }

  // The gate reads PRESENCE unfiltered, not the filtered lists: a user with
  // nothing saved and one draft (the normal mid-split state) who types a
  // non-matching query must keep the box and get the no-match line, not watch
  // the whole section — the input they are typing in — unmount.
  if ((workspaces?.length ?? 0) === 0 && (draftWorkspaces?.length ?? 0) === 0) return null;

  const savedRows = shownWorkspaces.map((w) => (
    <WorkspaceActionsMenu key={w.id} workspace={w}>
      <Link
        to="/workspaces/$id"
        params={{ id: w.id }}
        className={recentClass(location.pathname === `/workspaces/${w.id}`)}
      >
        {w.name}
      </Link>
    </WorkspaceActionsMenu>
  ));
  const draftRows = shownDrafts.map((e) => (
    <Link
      key={e.row.id}
      to="/workspaces/$id"
      params={{ id: e.row.id }}
      className={recentClass(e.row.id === activeWorkspaceId)}
    >
      {e.label}
    </Link>
  ));

  return (
    <div className={location.pathname === "/workspaces" ? "mt-1.5" : undefined}>
      {/* The search rides above both sections, same posture as the subshell
          filter; it stays up while the query is written so a no-match screen
          still lets you clear the text. */}
      <div className="px-2 pt-1 pb-2">
        <Input
          value={workspaceQuery}
          onChange={(e) => setWorkspaceQuery(e.target.value)}
          placeholder="Filter workspaces…"
          aria-label="Filter workspaces"
          className="h-7 text-detail"
        />
      </div>
      {/* Saved — the list already excludes drafts. Its header only appears
          (collapsible) when a Drafts section also does, to tell the two apart;
          with nothing unsaved the recents sit under "Workspaces" alone. */}
      {shownWorkspaces.length > 0 &&
        (showDraftSection ? (
          <WsSection
            id="saved"
            label="Saved"
            count={shownWorkspaces.length}
            collapsed={isCollapsed("saved")}
            disabled={workspaceSearch !== ""}
            onToggle={() => toggleWsSection("saved")}
          >
            {savedRows}
          </WsSection>
        ) : (
          savedRows
        ))}
      {/* Drafts — every unsaved workspace. The trashcan discards the rest
          (sparing the active draft), the server doing the sweep. */}
      {showDraftSection && (
        <WsSection
          id="drafts"
          label="Drafts"
          count={shownDrafts.length}
          collapsed={isCollapsed("drafts")}
          disabled={workspaceSearch !== ""}
          onToggle={() => toggleWsSection("drafts")}
          action={
            <TippedIconButton
              tooltip={activeIsDraft ? "Discard your other unsaved workspaces" : "Discard all unsaved workspaces"}
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              onClick={() => void discardOtherDrafts()}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </TippedIconButton>
          }
        >
          {draftRows}
        </WsSection>
      )}
      {wsActionError && <p className="px-3 py-1 text-destructive text-detail">{wsActionError}</p>}
      {workspaceSearch && shownWorkspaces.length === 0 && !showDraftSection && (
        <p className="px-3 py-1 text-detail text-muted-foreground">No workspaces match.</p>
      )}
    </div>
  );
}
