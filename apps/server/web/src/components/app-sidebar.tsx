import { Button, cn, Input } from "@internal/node-admin";
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
  Shield,
  SlidersHorizontal,
  Smartphone,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AboutDialog } from "@/components/about-dialog";
import { MobileInstallDialog } from "@/components/mobile-install-dialog";
import { useQuickAdd } from "@/components/quick-add";
import { SubshellNodeGroup } from "@/components/sidebar/SubshellNodeGroup";
import { SubshellRecentRow } from "@/components/sidebar/SubshellRecentRow";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceActionsMenu } from "@/components/workspace-actions-menu";
import { useClockTick } from "@/hooks/use-clock-tick";
import { useInstancePlugins } from "@/hooks/use-instance-plugins";
import { useNodes } from "@/hooks/use-nodes";
import { useOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { usePresets } from "@/hooks/use-presets";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { signOutAndRedirect, useCurrentUser } from "@/lib/auth";
import { desktopInvoke, isDesktop, onDesktopAction } from "@/lib/desktop";
import {
  collapsedNodeGroups,
  commsGroupOpen,
  setCollapsedNodeGroups,
  setCommsGroupOpen,
  toggleNodeGroup,
} from "@/lib/sidebar-node-group-pref";
import { RECENT_LIMIT, recentWorkspaceLinks } from "@/lib/sidebar-recents";
import { filterSubshells } from "@/lib/subshell-filter";
import { ACTIVITY_TICK_MS } from "@/lib/subshell-indicator";
import {
  CROSS_AGENT_GROUP_ID,
  FALLBACK_NODE_ID,
  groupSubshellsByNode,
  needsAttention,
  nodeLabelFor,
  partitionCrossAgent,
} from "@/lib/subshell-node-groups";

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
      // After Users, because a door is a question about who gets in: the two
      // pages are the accounts and the ways to reach them (spec 2026-09-24 §7).
      { to: "/settings/auth", label: "Auth", icon: Shield, short: "Auth" },
      { to: "/settings/api-keys", label: "API keys", icon: KeyRound, short: "Keys" },
      { to: "/settings/plugins", label: "Plugins", icon: Puzzle, short: "Plug" },
      // "Service", not "Server": the control-plane host's own node row is
      // named Server by default, and every card on this page is about the
      // running process — who supervises it and since when. (Where it
      // listens moved to Networking on 2026-09-17; what it logged moved to
      // Logs on 2026-09-20.)
      { to: "/settings/service", label: "Service", icon: Power, short: "Svc" },
      // After Service, because it holds both halves of address: where this
      // server listens (the Addresses card, here from Service since
      // 2026-09-17) and how anything not on this machine gets to it.
      { to: "/settings/networking", label: "Networking", icon: Network, short: "Net" },
      // Beside Service, because the two are about the same machine: Service is
      // the process as it runs now, Updates is what it could be running next.
      { to: "/settings/updates", label: "Updates", icon: ArrowUpCircle, short: "Upd" },
      { to: "/settings/status", label: "Status", icon: Activity, short: "Stat" },
      { to: "/settings/logs", label: "Logs", icon: ScrollText, short: "Logs" },
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
   * riding one live socket. A second implementation would lose every one of those
   * silently and then drift.
   */
  variant?: "web" | "desktop";
}) {
  // ONE tick for the rail's status dots, never one per row. With the feed
  // event-driven nothing arrives to mark elapsed time, so a subshell going
  // quiet needs a clock to be seen going idle (spec 2026-09-19 §4.5).
  useClockTick(ACTIVITY_TICK_MS);
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const q = subshellQuery.trim();
  // Sorted by liveness BEFORE the recents slice (band order documented in
  // use-ordered-subshells), so a pile of old ended sessions can never crowd a
  // live one out of the rail. The filter mode shares the same run.
  const byStatus = useOrderedSubshells();
  // Grouped by the MACHINE each runs on (lib/subshell-node-groups), with the
  // cap applied per node — so a second machine's work can never be crowded
  // out by the first's, and every group's own pile of ended sessions still
  // loses to its own live ones. Filter mode caps nothing: a search that hid
  // its own ninth match would be lying about what the instance holds.
  const { data: nodeData } = useNodes();
  // Names only, over the catalog the launch pickers already cache. An
  // unresolvable harness degrades to its id, which is a readable slug
  // ("claude-code") — see the clone dialog, which makes the same trade.
  const { data: pluginData } = useInstancePlugins();
  const agentLabel = useCallback(
    (harnessId: string) => pluginData?.plugins.find((p) => p.id === harnessId)?.name ?? harnessId,
    [pluginData],
  );
  // The tooltip's `Preset:` line, same caller-resolves pattern: one read of
  // the list the launch form and /presets already cache, keyed alike. A
  // presetId that names no row (loading, or since deleted) degrades to the
  // id — the row HAS a preset, and that is the fact worth showing.
  const { data: presetData } = usePresets();
  const presetLabel = useCallback(
    (presetId: string | null): string | undefined =>
      presetId === null ? undefined : (presetData?.find((p) => p.id === presetId)?.name ?? presetId),
    [presetData],
  );
  // The one filtered list both rail consumers read: the machine groups AND the
  // Needs Attention spotlight. Deriving it once makes "the spotlight sees the
  // exact rows the groups see" a fact of the code rather than two identical
  // expressions kept in sync by a comment.
  const railRows = q ? filterSubshells(byStatus, subshellQuery) : byStatus;
  // Panes an AGENT opened over MCP leave the machine groups entirely
  // (operator ask 2026-09-25): they are internal cross-agent comms, filed in
  // one section of their own below the machines, each row naming the machine
  // it runs on since the section spans them. The partition runs on the
  // FILTERED list, so a search matches them exactly like a machine's rows.
  const { human: railHuman, comms: railComms } = partitionCrossAgent(railRows);
  const commsGroup = {
    nodeId: CROSS_AGENT_GROUP_ID,
    label: "Cross-agent comms",
    // The header's hover line is the whole explanation; two sentences max,
    // per the design system's rule for UI text.
    title:
      "Panes an agent opened over MCP to talk to another agent. Created with the bell off; toggle it from a row's menu.",
    total: railComms.length,
    // The same per-group cap the machines get, and the same exemption while
    // filtering: a search that hid its own ninth match lies.
    subshells: q === "" ? railComms.slice(0, RECENT_LIMIT) : railComms,
  };
  // NOT memoised, deliberately: a group's rank re-derives activity against
  // the CLOCK, so a `useMemo` keyed on the data would freeze the group order
  // between feed frames and undo the liveliest-member ordering the 20 s tick
  // exists to maintain. The pass is O(rows) with a Map, per tick and per
  // keystroke — the frame it costs is one the rail re-renders for anyway.
  const nodeGroups = groupSubshellsByNode(railHuman, nodeData?.nodes, {
    limit: q ? undefined : RECENT_LIMIT,
    // "Unanswered" means NO successful read has ever committed: in flight, or
    // failed with nothing cached. It cannot be `isPending || isError` — a
    // background REFRESH that fails on a populated cache reports `isError`
    // while keeping the data, and re-labelling resolved headers to short ids
    // on a transient blip would be the header flickering a doubt it has no
    // reason to hold. Stale-but-cached beats a verdict from a failed retry.
    unanswered: nodeData === undefined,
  });
  // The "Needs Attention" spotlight above the machine groups (spec 2026-09-24):
  // `railRows` — the same rows the groups are built from — narrowed to the
  // owner's unseen pushes. Computed from the filter set, not from `nodeGroups`,
  // so a match in filter mode shows here exactly as it shows in the
  // (forced-open) group, and the cap that groups apply never hides a pane that
  // pushed.
  const attentionRows = needsAttention(railRows);
  // The "No matches" empty state must count the comms section too: a filter
  // that hits only a cross-agent pane would otherwise say "No matches" above a
  // row it is showing.
  const listedCount = nodeGroups.reduce((sum, group) => sum + group.subshells.length, 0) + commsGroup.subshells.length;
  // Which node groups this device has shut. Read once at mount — the rail
  // lives for the session, so re-reading storage on every render would buy
  // nothing but a synchronous read per frame.
  const [collapsedGroups, setCollapsedGroups] = useState(collapsedNodeGroups);
  const toggleNodeGroupOpen = useCallback((nodeId: string) => {
    setCollapsedGroups((prev) => setCollapsedNodeGroups(toggleNodeGroup(prev, nodeId)));
  }, []);
  // The comms section's own open state: CLOSED until this device opens it
  // (operator ask 2026-09-25), because its rows can multiply silently while
  // the machines' groups cannot. Separate pref for the inverted default (see
  // `sidebar-node-group-pref.ts`).
  const [commsOpen, setCommsOpen] = useState(commsGroupOpen);
  const toggleCommsOpen = useCallback(() => {
    setCommsOpen((prev) => setCommsGroupOpen(!prev));
  }, []);
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
              {!collapsed && item.to === "/" && q !== "" && listedCount === 0 && (
                <p className="px-3 py-1 text-detail text-muted-foreground">No matches.</p>
              )}
              {!collapsed && item.to === "/" && attentionRows.length > 0 && (
                <section aria-label="Needs Attention" className="mb-1">
                  <div className="flex w-full items-center gap-2 py-1 pr-2 pl-3 text-detail text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate font-strong">Needs Attention</span>
                    <span className="shrink-0 tabular-nums opacity-70">{attentionRows.length}</span>
                  </div>
                  {attentionRows.map((sub) => (
                    <SubshellRecentRow
                      key={`attention-${sub.id}`}
                      subshell={sub}
                      active={location.pathname === `/subshells/${sub.id}`}
                      nodeLabel={
                        nodeLabelFor(sub.nodeId || FALLBACK_NODE_ID, nodeData?.nodes, nodeData === undefined).label
                      }
                      agentLabel={agentLabel(sub.harnessId)}
                      presetLabel={presetLabel(sub.presetId)}
                    />
                  ))}
                </section>
              )}
              {!collapsed &&
                item.to === "/" &&
                nodeGroups.map((group) => (
                  <SubshellNodeGroup
                    key={group.nodeId}
                    nodeId={group.nodeId}
                    label={group.label}
                    title={group.title}
                    count={group.total}
                    // While filtering, every group is open whatever this
                    // device remembers: a match hidden inside a shut group
                    // reads as a filter that does not work. The header is
                    // INERT for the duration rather than merely overridden —
                    // a live chevron here would write the collapse to
                    // storage behind a screen that moves nothing, and the
                    // group would shut itself the moment the filter cleared.
                    open={q !== "" || !collapsedGroups.includes(group.nodeId)}
                    disabled={q !== ""}
                    onToggle={() => toggleNodeGroupOpen(group.nodeId)}
                  >
                    {group.subshells.map((sub) => (
                      <SubshellRecentRow
                        key={sub.id}
                        subshell={sub}
                        active={location.pathname === `/subshells/${sub.id}`}
                        nodeLabel={group.label}
                        agentLabel={agentLabel(sub.harnessId)}
                        presetLabel={presetLabel(sub.presetId)}
                      />
                    ))}
                  </SubshellNodeGroup>
                ))}
              {/* The cross-agent comms section (operator ask 2026-09-25), below
                  the machines and only when there is something to file. It
                  reuses the machine group's collapsing IDIOM but carries its
                  own preference, because its default is the other way: closed
                  (operator ask 2026-09-25). Each row's subline names its own
                  machine (the section header cannot, it spans them all). */}
              {!collapsed && item.to === "/" && commsGroup.total > 0 && (
                <SubshellNodeGroup
                  key={commsGroup.nodeId}
                  nodeId={commsGroup.nodeId}
                  label={commsGroup.label}
                  title={commsGroup.title}
                  count={commsGroup.total}
                  open={q !== "" || commsOpen}
                  disabled={q !== ""}
                  onToggle={toggleCommsOpen}
                >
                  {commsGroup.subshells.map((sub) => {
                    const machineLabel = nodeLabelFor(
                      sub.nodeId || FALLBACK_NODE_ID,
                      nodeData?.nodes,
                      nodeData === undefined,
                    ).label;
                    return (
                      <SubshellRecentRow
                        key={`comms-${sub.id}`}
                        subshell={sub}
                        active={location.pathname === `/subshells/${sub.id}`}
                        nodeLabel={machineLabel}
                        subline={machineLabel}
                        agentLabel={agentLabel(sub.harnessId)}
                        presetLabel={presetLabel(sub.presetId)}
                      />
                    );
                  })}
                </SubshellNodeGroup>
              )}
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
        {/* Shown EVERYWHERE, desktop shells included — it was gated on
            `!isDesktop()` for half a day on the reasoning that a Tauri webview
            cannot install a PWA. True, and beside the point: this dialog does
            not ask the window showing it to install anything. Its payload is a
            QR code, which is read by a DIFFERENT device, and somebody sitting
            at Subshell Server on their laptop is the likeliest person in the
            product to want Subshell on their phone. The gate hid it from them.

            It degrades correctly there rather than by luck: the server app
            OPENS its window on loopback, so `window.location.origin` is
            usually not offerable — and the picker's other two sources still answer, or the
            dialog says it knows no address a phone can reach, which on a
            loopback-only instance is the true answer.

            Not in the user menu beside About: this is not an account action,
            and a dialog mounted in a closing menu goes with the menu. */}
        <button
          type="button"
          title={collapsed ? "Subshell for Mobile" : undefined}
          aria-label="Subshell for Mobile"
          onClick={() => setMobileOpen(true)}
          className={cn(
            // The nav rows' classes minus the active gradient: this one opens
            // a dialog, so it is never "where you are".
            "flex w-full cursor-pointer items-center rounded-md py-2 text-sm transition-colors",
            "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
            collapsed ? "justify-center px-2" : "gap-3 px-3",
          )}
        >
          <Smartphone className="h-4 w-4 shrink-0 -translate-y-px" />
          {!collapsed && "Subshell for Mobile"}
        </button>
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
        {/* Its trigger is the rail row above, not this footer — both
            dialogs live here so neither is mounted inside something that
            can close underneath it. */}
        <MobileInstallDialog open={mobileOpen} onOpenChange={setMobileOpen} />
      </div>
    </aside>
  );
}
