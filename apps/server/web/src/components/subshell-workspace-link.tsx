import { Button } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import type { JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSubshellWorkspaces } from "@/hooks/use-subshell-workspaces";
import type { WorkspaceRow } from "@/types/workspace";

/** What a draft is called anywhere it sits beside named workspaces. */
const DRAFT_LABEL = "Unsaved workspace";

/** One workspace the subshell is on, as the control offers it. */
export interface WorkspaceLinkOption {
  /** Workspace id — the link target */
  id: string;
  /** The workspace's name, or {@link DRAFT_LABEL} for an unsaved one */
  label: string;
  /** True for an unsaved workspace */
  draft: boolean;
}

/** Everything the subshell header needs to offer a way into this subshell's workspaces. */
export interface WorkspaceLinkView {
  /** The control's accessible name */
  ariaLabel: string;
  /** Every workspace, drafts first then most recently updated */
  options: WorkspaceLinkOption[];
}

/**
 * Decides what the subshell header offers for the workspaces it is on.
 *
 * A subshell may be on any number of them — panes are per-workspace rows, and
 * nothing stops the same subshell appearing in several arrangements. The
 * control used to pick ONE and stay silent about the rest, which is wrong in
 * both directions: it hid workspaces, and it named a single one as though it
 * were the only one. The header is tight on space, so the control carries no
 * workspace names (operator ruling 2026-09-27): an icon and the count, and
 * every click opens the same menu.
 *
 * **Drafts lead and are named for what they are.** A draft's stored name is a
 * placeholder nobody chose (the subshell's own name at the moment of the
 * split), so showing it would invent a title the person never typed; and a
 * draft is almost always the split they just made, which is the thing they are
 * most likely coming back for.
 *
 * The sort is stable, so workspaces the server already ordered by recency keep
 * that order when their timestamps tie — which they do, since a split writes
 * several rows inside one millisecond.
 * @param workspaces - The caller's workspaces holding this subshell
 * @returns What to render, or null when the subshell is on none
 */
export function workspaceLinkView(workspaces: WorkspaceRow[]): WorkspaceLinkView | null {
  if (workspaces.length === 0) return null;
  const ordered = [...workspaces].sort((a, b) => {
    if (a.draft !== b.draft) return a.draft ? -1 : 1;
    if (a.updatedAt === b.updatedAt) return 0;
    return a.updatedAt > b.updatedAt ? -1 : 1;
  });
  const options = ordered.map((w) => ({ id: w.id, label: w.draft ? DRAFT_LABEL : w.name, draft: w.draft }));
  const n = options.length;
  return {
    ariaLabel: n === 1 ? "Show the workspace this subshell is on" : `Show the ${n} workspaces this subshell is on`,
    options,
  };
}

/**
 * "This subshell is also on a workspace" — the way back from a subshell page
 * to the arrangements it belongs to (spec 2026-09-14 §4).
 *
 * Renders nothing when there are none, which is the common case: a subshell
 * that was never split is on no workspace, and an absent control says that
 * better than a disabled one. It names NO workspace (operator ruling
 * 2026-09-27: the header has no space to spend on it) — just the icon and how
 * many workspaces there are — and always opens a menu, even for the lone one;
 * the menu's rows are real links, so middle-click and open-in-new-tab are
 * still there.
 */
export function SubshellWorkspaceLink({ subshellId }: { subshellId: string }): JSX.Element | null {
  const { data: workspaces } = useSubshellWorkspaces(subshellId);
  const view = workspaces ? workspaceLinkView(workspaces) : null;
  if (!view) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={view.ariaLabel} />}>
        <LayoutDashboard className="h-3.5 w-3.5" />
        <span className="tabular-nums">{view.options.length}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {view.options.map((option) => (
          // A real link per row: the menu is navigation, so middle-click and
          // open-in-new-tab have to keep working the way the single-workspace
          // button already does.
          <DropdownMenuItem
            key={option.id}
            render={<Link to="/workspaces/$id" params={{ id: option.id }} />}
            // The row IS an anchor; Base UI keeps `role="menuitem"` either
            // way, and saying so is what stops it assuming native button
            // semantics an <a> cannot honour.
            nativeButton={false}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            <span className={option.draft ? "truncate text-muted-foreground" : "truncate"}>{option.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
