import { Link, useLocation } from "@tanstack/react-router";
import { ChevronLeft, LayoutDashboard, LogOut, type LucideIcon, Settings, TerminalSquare, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSessionsList } from "@/hooks/use-sessions";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { authClient } from "@/lib/auth-client";
import { recentSessionLinks, recentWorkspaceLinks } from "@/lib/sidebar-recents";
import { cn } from "@/lib/utils";

/** localStorage key for the collapsed state (persists across reloads). */
const COLLAPSED_KEY = "mote.sidebarCollapsed";

/** Sidebar item: route target + icon. */
interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Optional short label shown when the rail is collapsed. */
  short?: string;
}

const NAV_ITEMS: NavItem[] = [
  // Terminal, like the empty sessions box — sessions are terminal harnesses,
  // not a grid (the grid icon belongs to the tiles/list view toggle).
  { to: "/", label: "Sessions", icon: TerminalSquare },
  { to: "/workspaces", label: "Workspaces", icon: LayoutDashboard, short: "Wksp" },
  { to: "/profiles", label: "Profiles", icon: Settings, short: "Prof" },
  { to: "/settings", label: "Settings", icon: Settings, short: "Sets" },
  { to: "/users", label: "Users", icon: Users, short: "Users" },
];

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
      {/* Brand — collapsed: a centered diamond that expands the rail */}
      <div className="flex items-center justify-between border-border border-b px-3 py-4">
        {collapsed ? (
          <button
            type="button"
            onClick={toggle}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            className="flex w-full cursor-pointer items-center justify-center rounded-md py-1 font-bold text-lg text-primary transition-colors hover:bg-accent/50"
          >
            ◆
          </button>
        ) : (
          <>
            <Link to="/" className="flex items-center gap-2 font-bold text-lg">
              <span className="text-primary">◆</span> Mote
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
        {NAV_ITEMS.map((item) => {
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
                    className={recentClass(location.pathname === `/sessions/${r.id}`)}
                  >
                    {r.label}
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
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "sm"}
          className={cn("text-muted-foreground", !collapsed && "w-full justify-start gap-2")}
          title={collapsed ? "Logout" : undefined}
          onClick={() => void signOut()}
        >
          <LogOut className="h-4 w-4 shrink-0" /> {!collapsed && "Logout"}
        </Button>
      </div>
    </aside>
  );
}
