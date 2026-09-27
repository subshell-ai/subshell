import {
  Activity,
  ArrowUpCircle,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Power,
  Puzzle,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  Shield,
  SlidersHorizontal,
  TerminalSquare,
  Users,
} from "lucide-react";

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
