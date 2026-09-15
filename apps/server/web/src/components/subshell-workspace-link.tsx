import { Link } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
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
  /** The control's visible text */
  label: string;
  /** The control's accessible name */
  ariaLabel: string;
  /** Every workspace, drafts first then most recently updated */
  options: WorkspaceLinkOption[];
}

/**
 * Decides what the subshell page says about the workspaces it is on.
 *
 * A subshell may be on any number of them — panes are per-workspace rows, and
 * nothing stops the same subshell appearing in several arrangements. The
 * control used to pick ONE and stay silent about the rest, which is wrong in
 * both directions: it hid workspaces, and it named a single one as though it
 * were the only one. So one is a direct link and several are a count with a
 * menu behind it.
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

  if (options.length > 1) {
    const label = `In ${options.length} workspaces`;
    return { label, ariaLabel: `Show the ${options.length} workspaces this subshell is on`, options };
  }
  const only = ordered[0];
  if (!only) return null;
  return only.draft
    ? { label: "Open unsaved workspace", ariaLabel: "Open the unsaved workspace this subshell is on", options }
    : { label: `In “${only.name}”`, ariaLabel: `Open workspace ${only.name}`, options };
}

/**
 * "This subshell is also on a workspace" — the way back from a subshell page
 * to the arrangements it belongs to (spec 2026-09-14 §4).
 *
 * Renders nothing when there are none, which is the common case: a subshell
 * that was never split is on no workspace, and an absent control says that
 * better than a disabled one. One workspace is a plain link; several open a
 * menu, because there is no single destination to send the click to.
 */
export function SubshellWorkspaceLink({ subshellId }: { subshellId: string }): JSX.Element | null {
  const { data: workspaces } = useSubshellWorkspaces(subshellId);
  const view = workspaces ? workspaceLinkView(workspaces) : null;
  if (!view) return null;

  const only = view.options.length === 1 ? view.options[0] : null;
  if (only) {
    return (
      <Button
        variant="ghost"
        size="sm"
        // `Button render={<Link/>}` is the house idiom (see
        // `detail-back-header.tsx`), and it is deliberately NOT given
        // `nativeButton={false}`: that would announce this navigation control
        // as a button when the correct role for it is a link.
        render={<Link to="/workspaces/$id" params={{ id: only.id }} />}
        aria-label={view.ariaLabel}
      >
        <LayoutDashboard className="h-3.5 w-3.5" />
        {/* Icon-only below `sm`, exactly as the Split button beside it in this
            header already is. The `aria-label` above carries the whole name
            either way, so hiding the text costs nothing but width. */}
        <span className="hidden max-w-40 truncate sm:inline">{view.label}</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={view.ariaLabel} />}>
        <LayoutDashboard className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{view.label}</span>
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
