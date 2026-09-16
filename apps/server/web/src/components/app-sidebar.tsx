import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowUpCircle,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Plus,
  Power,
  Puzzle,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  SlidersHorizontal,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AboutDialog } from "@/components/about-dialog";
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
import { desktopInvoke, isDesktop, onDesktopAction } from "@/lib/desktop";
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

/**
 * A label with a chevron that opens to pages. NEVER a page itself (spec
 * 2026-09-11 §1): a header that is also a link needs a toggle button beside
 * it, and this rail already refuses to nest interactive elements (see the
 * quick-add + below). A label-only header has one job.
 */
export interface NavGroup {
  /** Stable key: the React key, and what a chevron press is recorded against. */
  id: string;
  label: string;
  /** Shown beside the label when expanded; never shown collapsed (§3.3). */
  icon: LucideIcon;
  children: NavItem[];
  /** Gates the WHOLE group. Children carry no flag of their own. */
  requiresAdmin?: boolean;
}

export type NavEntry = NavItem | NavGroup;

/** Narrows a rail entry to a group. Groups are the ones with children. */
export const isNavGroup = (entry: NavEntry): entry is NavGroup => "children" in entry;

const NAV_ENTRIES: NavEntry[] = [
  // Terminal, like the empty subshells box — subshells are terminal harnesses,
  // not a grid (the grid icon belongs to the tiles/list view toggle).
  { to: "/", label: "Subshells", icon: TerminalSquare },
  { to: "/workspaces", label: "Workspaces", icon: LayoutDashboard, short: "Wksp" },
  { to: "/nodes", label: "Nodes", icon: Server, short: "Nodes" },
  { to: "/presets", label: "Presets", icon: SlidersHorizontal, short: "Preset" },
  // On the label (spec 2026-09-11 §2.1). The single entry here used to read
  // "Instance", not "Server", because the control-plane host's own NODE is
  // named Server by default and on /nodes an admin saw that word twice, on two
  // different things. This is a GROUP of pages now, and "Server Settings" is
  // two words: it reads as the plane's settings rather than as that node, and
  // the collision the old label was avoiding is accepted here deliberately —
  // the group has to say what the pages under it configure, and "Instance
  // Settings" would name a thing no page inside it is called.
  {
    id: "server-settings",
    label: "Server Settings",
    icon: ServerCog,
    requiresAdmin: true,
    children: [
      // ServerCog above so the plain gear can stay on General and Server stays
      // on Nodes — three related icons, three different things.
      { to: "/settings", label: "General", icon: Settings, short: "Gen" },
      { to: "/settings/users", label: "Users", icon: Users, short: "Users" },
      { to: "/settings/api-keys", label: "API keys", icon: KeyRound, short: "Keys" },
      { to: "/settings/plugins", label: "Plugins", icon: Puzzle, short: "Plug" },
      // "Service", not "Server": the control-plane host's own node row is
      // named Server by default, and every card on this page is about the
      // running process — where it listens, who supervises it, what it logged.
      { to: "/settings/service", label: "Service", icon: Power, short: "Svc" },
      // After Service, because it answers the question Service leaves open:
      // that page says where this server listens, this one says how anything
      // that is not on this machine gets to it.
      { to: "/settings/networking", label: "Networking", icon: Network, short: "Net" },
      // Beside Service, because the two are about the same machine: Service is
      // the process as it runs now, Updates is what it could be running next.
      { to: "/settings/updates", label: "Updates", icon: ArrowUpCircle, short: "Upd" },
      { to: "/settings/status", label: "Status", icon: Activity, short: "Stat" },
      { to: "/settings/audit", label: "Audit log", icon: ScrollText, short: "Audit" },
    ],
  },
];

/**
 * The rail's entries for this viewer (spec 2026-09-02 settings-split §4,
 * regrouped by 2026-09-11 §3.2): an admin-gated entry hides unless the server
 * says so, and while the flag is still unknown (first fetch) it stays hidden
 * (unknown ≠ open). A group drops as a WHOLE — its children carry no flag of
 * their own, so there is one gate to reason about rather than seven.
 */
export function visibleNavEntries(isAdmin: boolean | undefined): readonly NavEntry[] {
  return NAV_ENTRIES.filter((entry) => !entry.requiresAdmin || isAdmin === true);
}

/**
 * Every PAGE the viewer may reach from the rail, groups flattened, in rail
 * order. The gate lives once, in {@link visibleNavEntries}; this is the flat
 * view of the same answer.
 *
 * **Nothing in the app calls this — the tests are its only consumers**, and
 * that is deliberate rather than dead code left behind. The rail renders from
 * the TREE, but the question the tests need to ask is about pages ("can a
 * member reach /settings/users from here?"), which a tree makes them walk. Keeping the
 * flat view as the tested surface is also what let the group land without
 * rewriting the assertions that predate it.
 */
export function visibleNavItems(isAdmin: boolean | undefined): readonly NavItem[] {
  return visibleNavEntries(isAdmin).flatMap((entry) => (isNavGroup(entry) ? entry.children : [entry]));
}

/**
 * Whether a group renders open: **the route decides, and a click overrides it
 * until the route changes.**
 *
 * So a group is open exactly while you are on one of its pages, and shut
 * otherwise — the rail stays as short as where you are — and the chevron can
 * always be used, in both directions, including to shut a group you are
 * inside.
 *
 * The first version of this made a group holding the current page
 * unconditionally open, on the reasoning that the rail must be able to say
 * where you are. That reasoning was wrong twice over: the group header stays
 * lit either way, so nothing is lost by shutting it — and a chevron that
 * refuses on the one page a person is most likely to press it does not read
 * as a rule, it reads as broken. Reported 2026-09-12.
 */
export function groupOpen(override: boolean | undefined, childActive: boolean): boolean {
  return override ?? childActive;
}

/** Classes for a "recent" sub-link: a compact row under its nav item. */
function recentClass(active: boolean): string {
  return cn(
    "block truncate rounded-md py-1 pr-3 pl-10 text-detail transition-colors",
    active
      ? "font-strong text-accent-foreground"
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
  // Admin-nav gate for the Server Settings group (spec 2026-09-02
  // settings-split §4) — the same cached query the emergency banner /
  // Add-node dialog use.
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
  // The About dialog the user menu raises. Held here rather than in the menu
  // because choosing an item closes the menu, which would take the dialog
  // with it.
  const [aboutOpen, setAboutOpen] = useState(false);
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
  // Chevron presses, and the route they were made on. Keeping the path here
  // is what expires them: a navigation makes `stale` true and the rendered
  // state falls back to the route's own answer, with no effect and no second
  // render. Nothing is persisted — the preference is meant to last until you
  // go somewhere else, so writing it to disk would outlive its own meaning.
  const [pressed, setPressed] = useState<{ path: string; open: Record<string, boolean> }>({
    path: location.pathname,
    open: {},
  });
  const overrides = pressed.path === location.pathname ? pressed.open : {};
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

  // Flips what the header is CURRENTLY SHOWING, so the first press always
  // visibly does something — flipping a stored flag instead is how a press
  // becomes a no-op whenever that flag and the route already disagree.
  //
  // The shown value is recomputed INSIDE the setter from `prev` plus the
  // route fact, rather than half of it closed over from the render that
  // attached the handler. Both are correct today (React 19 flushes discrete
  // clicks synchronously, so the closure cannot be stale), but reading one
  // input from a closure and the other from `prev` is the idiom that stops
  // being correct quietly.
  const toggleGroup = useCallback(
    (id: string, childActive: boolean) => {
      const path = location.pathname;
      setPressed((prev) => {
        const open = prev.path === path ? prev.open : {};
        return { path, open: { ...open, [id]: !groupOpen(open[id], childActive) } };
      });
    },
    [location.pathname],
  );

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

  /**
   * One page row. Used for a top-level leaf and for a group's children alike,
   * so an active child carries exactly the same gradient as an active
   * top-level page — the indent is the only difference.
   */
  const navLink = (item: NavItem, indented: boolean) => (
    <Link
      to={item.to as never}
      title={collapsed ? `${item.label}${item.short ? ` (${item.short})` : ""}` : undefined}
      className={cn(
        "flex items-center rounded-md py-2 text-sm transition-colors",
        collapsed ? "justify-center px-2" : indented ? "gap-3 pr-3 pl-9" : "gap-3 px-3",
        location.pathname === item.to
          ? "bg-[linear-gradient(90deg,var(--nav-active-from),var(--nav-active-to))] font-strong text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
      )}
    >
      {/* -translate-y-px is optical, not a bug fix: the boxes are
          flex-centered, but labels like "Subshells" carry no descenders, so
          the eye centers them ~1px above the box center and the icon reads
          low (live review 2026-09-03). */}
      <item.icon className="h-4 w-4 shrink-0 -translate-y-px" />
      {!collapsed && item.label}
    </Link>
  );

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
        <p className="truncate px-3 pb-3 text-detail text-muted-foreground" title={publicSettings.instanceName}>
          {publicSettings.instanceName}
        </p>
      )}
      {collapsed && <div className="pb-3" />}

      {/* `min-h-0` is load-bearing, not tidying: a flex item's automatic minimum
          size is its CONTENT, so `flex-1` + `overflow-y-auto` alone still grows
          past the container and pushes the footer below the fold instead of
          scrolling. Invisible on a tall desktop rail; on the phone drawer it
          took one extra nav item to surface (e2e 08, 2026-09-12). */}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label="Main">
        {visibleNavEntries(publicSettings?.viewerIsAdmin).map((entry) => {
          if (isNavGroup(entry)) {
            // Collapsed rail: the children ARE the rail, with no header above
            // them. A header there would be an icon that navigates nowhere,
            // and this width exists so every page stays one click away.
            if (collapsed) {
              return (
                <Fragment key={entry.id}>
                  {entry.children.map((child) => (
                    <div key={child.to}>{navLink(child, false)}</div>
                  ))}
                </Fragment>
              );
            }
            const childActive = entry.children.some((child) => location.pathname === child.to);
            const open = groupOpen(overrides[entry.id], childActive);
            const listId = `nav-group-${entry.id}`;
            return (
              <div key={entry.id}>
                <button
                  type="button"
                  onClick={() => toggleGroup(entry.id, childActive)}
                  aria-expanded={open}
                  aria-controls={listId}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent/50 hover:text-accent-foreground",
                    // Never the active gradient — the header is not a page
                    // (§1). Closed with an active child it still has to say
                    // "you are in here", which is what the lit text does.
                    childActive && !open ? "text-accent-foreground" : "text-muted-foreground",
                  )}
                >
                  <entry.icon className="h-4 w-4 shrink-0 -translate-y-px" />
                  {entry.label}
                  <ChevronDown
                    className={cn("ml-auto h-4 w-4 shrink-0 transition-transform duration-200", !open && "-rotate-90")}
                  />
                </button>
                {/* Always rendered, hidden with `display:none` rather than
                    unmounted: `aria-controls` above must resolve to a real
                    element, and a reference to an id that exists only while
                    the group is open is one a screen reader cannot follow at
                    the moment the user needs it. `hidden` also takes the
                    links out of the tab order, so a closed group is not a
                    keyboard trap of six invisible stops. */}
                <div id={listId} className={cn("space-y-1 pt-1", !open && "hidden")}>
                  {entry.children.map((child) => (
                    <div key={child.to}>{navLink(child, true)}</div>
                  ))}
                </div>
              </div>
            );
          }
          const item = entry;
          return (
            <div key={item.to}>
              {/* The anchor for the quick-add +: the LINK ROW only — the
                  section wrapper also holds the recents below, so centering
                  there lands the + off the label (live-review screenshot,
                  2026-09-03). */}
              <div className="relative">
                {navLink(item, false)}
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
                    className="h-7 text-detail"
                  />
                </div>
              )}
              {!collapsed && item.to === "/" && q !== "" && listedSubshells.length === 0 && (
                <p className="px-3 py-1 text-detail text-muted-foreground">No matches.</p>
              )}
              {!collapsed &&
                item.to === "/" &&
                listedSubshells.map((sub) => (
                  <SubshellRecentRow
                    key={sub.id}
                    subshell={sub}
                    active={location.pathname === `/subshells/${sub.id}`}
                  />
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
        {/* A desktop window is a webview with no address bar, no second tab and
            no way to hand this page to the browser the person actually keeps
            their passwords in. So both shells offer the way out, and the page
            is what knows WHICH page to open.

            `isDesktop()`, not `isServerDesktop()`: this is one of exactly two
            surfaces that mean "either shell". Subshell Client's plane window is
            granted this one command precisely so this row can exist there.

            The path is the CURRENT route, search included, and Rust joins it
            onto the window's own origin — the page names no host. Last in the
            rail because it leaves the app; the footer below is the account, and
            this is not an account action. */}
        {isDesktop() && (
          <button
            type="button"
            // Collapsed only, like every sibling nav row: expanded, the label
            // is right there and a tooltip repeating it is noise.
            title={collapsed ? "Open in browser" : undefined}
            aria-label="Open in browser"
            onClick={() =>
              void desktopInvoke("desktop_open_in_browser", {
                path: `${location.pathname}${location.searchStr}`,
              })
            }
            className={cn(
              // The nav rows' own classes, minus the active gradient: this one
              // is never "where you are".
              "flex w-full cursor-pointer items-center rounded-md py-2 text-sm transition-colors",
              "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
              collapsed ? "justify-center px-2" : "gap-3 px-3",
            )}
          >
            <ExternalLink className="h-4 w-4 shrink-0 -translate-y-px" />
            {!collapsed && "Open in browser"}
          </button>
        )}
      </nav>

      <div className="border-border border-t p-2">
        {footerEnd?.({ collapsed })}
        <UserMenu
          name={user?.name ?? ""}
          email={user?.email ?? ""}
          collapsed={collapsed}
          onPreferences={() => void navigate({ to: "/preferences" })}
          onAccountSettings={() => void navigate({ to: "/account" })}
          onAbout={() => setAboutOpen(true)}
          onSignOut={() => void signOutAndRedirect()}
        />
        {/* Beside the menu rather than inside it: choosing an item closes the
            menu, and a dialog mounted in a closing menu goes with it. */}
        <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      </div>
    </aside>
  );
}
