import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ChevronLeft,
  LayoutDashboard,
  type LucideIcon,
  Plus,
  Server,
  Settings,
  SlidersHorizontal,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useQuickAdd } from "@/components/quick-add";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { signOutAndRedirect, useCurrentUser } from "@/lib/auth";
import { onDesktopAction } from "@/lib/desktop";
import { RECENT_LIMIT, recentWorkspaceLinks } from "@/lib/sidebar-recents";
import { filterSubshells } from "@/lib/subshell-filter";
import { cn } from "@/lib/utils";

/** localStorage key for the collapsed state (persists across reloads). */
const COLLAPSED_KEY = "subshell.sidebarCollapsed";

/** Sidebar item: route target + icon. */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Optional short label shown when the rail is collapsed. */
  short?: string;
  /** When true, the item shows only while the server reports the viewer is an admin. */
  requiresAdmin?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  // Terminal, like the empty subshells box — subshells are terminal harnesses,
  // not a grid (the grid icon belongs to the tiles/list view toggle).
  { to: "/", label: "Subshells", icon: TerminalSquare },
  { to: "/workspaces", label: "Workspaces", icon: LayoutDashboard, short: "Wksp" },
  { to: "/nodes", label: "Nodes", icon: Server, short: "Nodes" },
  { to: "/profiles", label: "Profiles", icon: SlidersHorizontal, short: "Prof" },
  { to: "/settings", label: "Server", icon: Settings, requiresAdmin: true },
  { to: "/settings/status", label: "Status", icon: Activity, requiresAdmin: true, short: "Stat" },
  { to: "/users", label: "Users", icon: Users, short: "Users" },
];

/**
 * The nav items a viewer may see (spec 2026-09-02 settings-split §4):
 * admin-only entries hide unless the server says so — and while the flag is
 * still unknown (first fetch) they stay hidden (unknown ≠ open). Pure so the
 * rule is testable without a router.
 */
export function visibleNavItems(isAdmin: boolean | undefined): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => !item.requiresAdmin || isAdmin === true);
}

/** Classes for a "recent" sub-link: a compact row under its nav item. */
function recentClass(active: boolean): string {
  return cn(
    "block truncate rounded-md py-1 pr-3 pl-10 text-xs transition-colors",
    active
      ? "font-medium text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
  );
}

/**
 * Persistent left navigation for the app shell, rendered in the root layout
 * beside the page outlet. Collapses to an icon rail (chevron in the top
 * right toggles it); the collapsed state persists in localStorage.
 *
 * Collapsed behavior:
 * - Clicking the brand diamond expands the rail (the ONLY expander).
 * - Nav icons stay navigable AND stay collapsed; their section name shows as
 *   a tooltip on hover.
 */
export function AppSidebar({
  forceExpanded = false,
  className,
  headerEnd,
  headerAbove,
  footerEnd,
  onQuickAdd,
  variant = "web",
}: {
  forceExpanded?: boolean;
  className?: string;
  /** Control rendered where the collapse chevron sits — the drawer host puts
   * its close button here so it can never float over a nav row (see
   * SheetContent's `showClose`). */
  headerEnd?: ReactNode;
  /**
   * Rendered as the rail's FIRST child, above the brand row.
   *
   * Exists for the desktop shell's drag strip, which has to span the rail and
   * only the rail: with the title bar gone the rail's top edge IS the title
   * bar, and a strip positioned from outside would have to guess a width that
   * changes when the rail collapses.
   */
  headerAbove?: ReactNode;
  /** Called after a quick-add + opens its dialog; the drawer host uses it to
   * dismiss the sheet so the dialog is never a second stacked modal. */
  onQuickAdd?: () => void;
  /**
   * Rendered above the user menu, INSIDE the footer. The desktop shell puts
   * its server pill here.
   *
   * A render prop rather than a node (unlike {@link headerEnd}) because
   * `collapsed` is private state: an outer wrapper cannot see it, and a footer
   * row that does not know the rail is 56px wide renders its label into a
   * clipped column. Handing it down is the only way it can be right in both.
   */
  footerEnd?: (ctx: { collapsed: boolean }) => ReactNode;
  /**
   * Which chrome this rail is wearing.
   *
   * Narrow on purpose: `desktop` widens the expanded rail from 14rem to 15rem
   * and nothing else. The rest of the desktop chrome — the traffic-light
   * inset, the drag strip, the server row — is supplied by the CALLER through
   * `className`, `headerAbove` and `footerEnd` (see
   * `components/desktop/desktop-sidebar.tsx`), so this component stays one
   * rail with one set of behaviours.
   *
   * That reuse is the point. This rail is the `application/x-subshell-id` drag
   * source, the live-status surface, the host of two context menus, the
   * quick-add trigger and the only consumer of the collapse preference, all
   * riding one SSE feed. A second implementation would lose every one of those
   * silently and then drift.
   */
  variant?: "web" | "desktop";
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const quickAdd = useQuickAdd();
  // Identity for the user menu (footer). "" fields while in flight — the
  // menu renders its own "Signed in" placeholder (UserMenu owns that string).
  const { data: user } = useCurrentUser();
  // Admin-nav gate for the Server entry (spec 2026-09-02 settings-split §4) —
  // the same cached query the emergency banner / Add-node dialog use.
  const { data: publicSettings } = usePublicSettings();
  // "Recent" sub-lists under Subshells / Workspaces — the quick jump that the
  // subshell page's switcher strip used to offer. Same query keys as the home
  // page, so every mutation and the page's polling keep these current; shown
  // only while the rail is expanded.
  const { data: workspaces } = useWorkspaces();
  const recentWorkspaces = recentWorkspaceLinks(workspaces);
  // Filter mode replaces the 8 recents with matches over the FULL cached list
  // (no server call — the list is already client-side). Same predicate as
  // the home page and the add-subshell dialog (lib/subshell-filter).
  const [subshellQuery, setSubshellQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const q = subshellQuery.trim();
  // Sorted by liveness BEFORE the recents slice (band order documented in
  // use-ordered-subshells), so a pile of old ended sessions can never crowd a
  // live one out of the rail. The filter mode shares the same run.
  const byStatus = useOrderedSubshells();
  const listedSubshells = q ? filterSubshells(byStatus, subshellQuery) : byStatus.slice(0, RECENT_LIMIT);
  const [collapsedState, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Inside the mobile drawer the rail is always expanded and the collapse
  // control is meaningless (the sheet IS the expander).
  const collapsed = forceExpanded ? false : collapsedState;
  const desktop = variant === "desktop";

  // Stable across renders: the effect below subscribes ONCE, so a toggle
  // recreated on every render would re-subscribe on each of them. The
  // functional setter is what lets this close over nothing.
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // storage unavailable (private mode) — state still toggles in-memory
      }
      return next;
    });
  }, []);

  // The desktop shell's View menu can collapse the rail and focus its filter.
  // Handled HERE rather than in the bridge because both touch state that is
  // private to this component — exporting it just to drive a menu item would
  // be a wider seam than the feature is worth.
  // Set by `focus-filter` when the rail is collapsed: the input does not exist
  // until the expanded branch renders, so the focus has to wait for it.
  const [focusFilterWhenOpen, setFocusFilterWhenOpen] = useState(false);

  useEffect(
    () =>
      onDesktopAction((action) => {
        if (action === "toggle-sidebar") toggle();
        else if (action === "focus-filter") {
          if (filterRef.current) filterRef.current.focus();
          // ⌘F was a silent no-op on a collapsed rail — the one state where a
          // user is most likely to reach for it.
          else {
            setFocusFilterWhenOpen(true);
            setCollapsed(false);
          }
        }
      }),
    [toggle],
  );

  useEffect(() => {
    if (!focusFilterWhenOpen || !filterRef.current) return;
    filterRef.current.focus();
    setFocusFilterWhenOpen(false);
  }, [focusFilterWhenOpen]);

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col border-border border-r bg-card transition-[width] duration-200",
        collapsed ? "w-14" : desktop ? "w-60" : "w-56",
        className,
      )}
    >
      {headerAbove}
      {/* Brand — collapsed: a centered /s mark that expands the rail */}
      <div className="flex items-center justify-between px-3 pt-4">
        {collapsed ? (
          <button
            type="button"
            onClick={toggle}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="flex w-full cursor-pointer items-center justify-center rounded-md py-1 transition-colors hover:bg-accent/50"
          >
            <img
              src="/icons/mark-40.png"
              srcSet="/icons/mark-80.png 2x, /icons/mark-120.png 3x"
              alt=""
              className="h-6 w-auto"
            />
          </button>
        ) : (
          <>
            <Link to="/" className="flex items-center gap-2" aria-label="Subshell">
              <img
                src="/icons/wordmark-80.png"
                srcSet="/icons/wordmark-80.png 1x, /icons/wordmark-120.png 2x"
                alt="Subshell"
                className="h-7 w-auto"
              />
            </Link>
            {forceExpanded ? (
              headerEnd
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground"
                onClick={toggle}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
              >
                <ChevronLeft className="h-4 w-4 transition-transform duration-200" />
              </Button>
            )}
          </>
        )}
      </div>
      {/* Which plane am I looking at? Only when expanded — the collapsed rail
          has no room for text, and the wordmark alone is the brand, not the
          instance. Server-resolved, so it is never blank. */}
      {!collapsed && publicSettings?.instanceName && (
        <p className="truncate px-3 pb-3 text-muted-foreground text-xs" title={publicSettings.instanceName}>
          {publicSettings.instanceName}
        </p>
      )}
      {collapsed && <div className="pb-3" />}

      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label="Main">
        {visibleNavItems(publicSettings?.viewerIsAdmin).map((item) => {
          const active = location.pathname === item.to;
          return (
            <div key={item.to}>
              {/* The anchor for the quick-add +: the LINK ROW only — the
                  section wrapper also holds the recents below, so centering
                  there lands the + off the label (live-review screenshot,
                  2026-09-03). */}
              <div className="relative">
                <Link
                  to={item.to as never}
                  title={collapsed ? `${item.label}${item.short ? ` (${item.short})` : ""}` : undefined}
                  className={cn(
                    "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                    collapsed ? "justify-center px-2" : "gap-3",
                    active
                      ? "bg-[linear-gradient(90deg,oklch(0.30_0.10_322),oklch(0.38_0.11_340))] font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                  )}
                >
                  {/* -translate-y-px is optical, not a bug fix: the boxes are
                      flex-centered, but labels like "Subshells" carry no
                      descenders, so the eye centers them ~1px above the box
                      center and the icon reads low (live review 2026-09-03). */}
                  <item.icon className="h-4 w-4 shrink-0 -translate-y-px" />
                  {!collapsed && item.label}
                </Link>
                {!collapsed && item.to === "/workspaces" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="New workspace"
                    title="New workspace"
                    className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 text-muted-foreground"
                    onClick={() => {
                      quickAdd.openNewWorkspace();
                      onQuickAdd?.();
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}
                {!collapsed && item.to === "/" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="New subshell"
                    title="New subshell"
                    className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 text-muted-foreground"
                    onClick={() => {
                      quickAdd.openLaunch();
                      onQuickAdd?.();
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {!collapsed && item.to === "/" && (
                <div className="px-2 pt-1 pb-2">
                  <Input
                    ref={filterRef}
                    value={subshellQuery}
                    onChange={(e) => setSubshellQuery(e.target.value)}
                    placeholder="Filter subshells…"
                    aria-label="Filter subshells"
                    className="h-7 text-xs"
                  />
                </div>
              )}
              {!collapsed && item.to === "/" && q !== "" && listedSubshells.length === 0 && (
                <p className="px-3 py-1 text-[10px] text-muted-foreground">No matches.</p>
              )}
              {!collapsed &&
                item.to === "/" &&
                listedSubshells.map((s) => (
                  <SubshellRecentRow key={s.id} subshell={s} active={location.pathname === `/subshells/${s.id}`} />
                ))}
              {!collapsed &&
                item.to === "/workspaces" &&
                recentWorkspaces.map((r) => {
                  const full = workspaces?.find((w) => w.id === r.id);
                  const row = (
                    <Link
                      key={r.id}
                      to="/workspaces/$id"
                      params={{ id: r.id }}
                      className={recentClass(location.pathname === `/workspaces/${r.id}`)}
                    >
                      {r.label}
                    </Link>
                  );
                  return full ? (
                    <WorkspaceActionsMenu key={r.id} workspace={full}>
                      {row}
                    </WorkspaceActionsMenu>
                  ) : (
                    <Fragment key={r.id}>{row}</Fragment>
                  );
                })}
            </div>
          );
        })}
      </nav>

      <div className="border-border border-t p-2">
        {footerEnd?.({ collapsed })}
        <UserMenu
          name={user?.name ?? ""}
          email={user?.email ?? ""}
          collapsed={collapsed}
          onPreferences={() => void navigate({ to: "/preferences" })}
          onAccountSettings={() => void navigate({ to: "/account" })}
          onSignOut={() => void signOutAndRedirect()}
        />
      </div>
    </aside>
  );
}
