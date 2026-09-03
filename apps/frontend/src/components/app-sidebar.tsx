import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, LayoutDashboard, type LucideIcon, Server, Settings, TerminalSquare, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useSessionsList } from "@/hooks/use-sessions";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { useCurrentUser } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { recentSessionLinks, recentWorkspaceLinks } from "@/lib/sidebar-recents";
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
  // Terminal, like the empty sessions box — sessions are terminal harnesses,
  // not a grid (the grid icon belongs to the tiles/list view toggle).
  { to: "/", label: "Sessions", icon: TerminalSquare },
  { to: "/workspaces", label: "Workspaces", icon: LayoutDashboard, short: "Wksp" },
  { to: "/nodes", label: "Nodes", icon: Server, short: "Nodes" },
  { to: "/profiles", label: "Profiles", icon: Settings, short: "Prof" },
  { to: "/settings", label: "Server", icon: Settings, requiresAdmin: true },
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

/** Logout: better-auth sign-out, clear the query cache, land on /login. */
async function signOut() {
  try {
    await authClient.signOut();
  } catch {
    // expired session — still clear client state and redirect
  }
  window.location.href = "/login";
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
export function AppSidebar({ forceExpanded = false, className }: { forceExpanded?: boolean; className?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  // Identity for the user menu (footer). "" fields while in flight — the
  // menu renders its own "Signed in" placeholder (UserMenu owns that string).
  const { data: user } = useCurrentUser();
  // Admin-nav gate for the Server entry (spec 2026-09-02 settings-split §4) —
  // the same cached query the emergency banner / Add-node dialog use.
  const { data: publicSettings } = usePublicSettings();
  // "Recent" sub-lists under Sessions / Workspaces — the quick jump that the
  // session page's switcher strip used to offer. Same query keys as the home
  // page, so every mutation and the page's polling keep these current; shown
  // only while the rail is expanded.
  const { data: sessions } = useSessionsList();
  const { data: workspaces } = useWorkspaces();
  const recentSessions = recentSessionLinks(sessions);
  const recentWorkspaces = recentWorkspaceLinks(workspaces);
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

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // storage unavailable (private mode) — state still toggles in-memory
      }
      return next;
    });
  }

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col border-border border-r bg-card transition-[width] duration-200",
        collapsed ? "w-14" : "w-56",
        className,
      )}
    >
      {/* Brand — collapsed: a centered /s mark that expands the rail */}
      <div className="flex items-center justify-between border-border border-b px-3 py-4">
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
                src="/icons/wordmark-40.png"
                srcSet="/icons/wordmark-80.png 2x, /icons/wordmark-120.png 3x"
                alt="Subshell"
                className="h-5 w-auto"
              />
            </Link>
            {!forceExpanded && (
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

      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label="Main">
        {visibleNavItems(publicSettings?.viewerIsAdmin).map((item) => {
          const active = location.pathname === item.to;
          return (
            <div key={item.to}>
              <Link
                to={item.to as never}
                title={collapsed ? `${item.label}${item.short ? ` (${item.short})` : ""}` : undefined}
                className={cn(
                  "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
                  collapsed ? "justify-center px-2" : "gap-3",
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && item.label}
              </Link>
              {!collapsed &&
                item.to === "/" &&
                recentSessions.map((r) => (
                  <Link
                    key={r.id}
                    to="/sessions/$id"
                    params={{ id: r.id }}
                    title={r.path ? `${r.label} — ${r.path}` : undefined}
                    className={recentClass(location.pathname === `/sessions/${r.id}`)}
                  >
                    <span className="block truncate">{r.label}</span>
                    {/* Working dir under the name — the same reading posture
                        the phone header took: the path is what locates a
                        session, the name alone does not. */}
                    {r.path ? <span className="block truncate text-[10px] opacity-70">{r.path}</span> : null}
                  </Link>
                ))}
              {!collapsed &&
                item.to === "/workspaces" &&
                recentWorkspaces.map((r) => (
                  <Link
                    key={r.id}
                    to="/workspaces/$id"
                    params={{ id: r.id }}
                    className={recentClass(location.pathname === `/workspaces/${r.id}`)}
                  >
                    {r.label}
                  </Link>
                ))}
            </div>
          );
        })}
      </nav>

      <div className="border-border border-t p-2">
        <UserMenu
          name={user?.name ?? ""}
          email={user?.email ?? ""}
          collapsed={collapsed}
          onAccountSettings={() => void navigate({ to: "/account" })}
          onSignOut={() => void signOut()}
        />
      </div>
    </aside>
  );
}
