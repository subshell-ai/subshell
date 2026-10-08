import { Button, cn } from "@internal/node-admin";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronLeft, ExternalLink, Smartphone } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AboutDialog } from "@/components/about-dialog";
import { MobileInstallDialog } from "@/components/mobile-install-dialog";
import { useQuickAdd } from "@/components/quick-add";
import { RailSectionActions } from "@/components/sidebar/rail-section-actions";
import { RailSubshells } from "@/components/sidebar/rail-subshells";
import { groupOpen, isNavGroup, type NavItem, visibleNavEntries } from "@/components/sidebar/sidebar-nav";
import { WorkspacesSection } from "@/components/sidebar/workspaces-section";
import { UserMenu } from "@/components/user-menu";
import { useClockTick } from "@/hooks/use-clock-tick";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { signOutAndRedirect, useCurrentUser } from "@/lib/auth";
import { desktopInvoke, isDesktop, onDesktopAction } from "@/lib/desktop";
import { readHiddenSections, revealHidden, toggleHidden, writeHiddenSections } from "@/lib/sidebar-section-hidden-pref";
import { ACTIVITY_TICK_MS } from "@/lib/subshell-indicator";

/** localStorage key for the collapsed state (persists across reloads). */
const COLLAPSED_KEY = "subshell.sidebarCollapsed";

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
  // The About dialog the user menu raises. Held here rather than in the menu
  // because choosing an item closes the menu, which would take the dialog
  // with it.
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // The rail's subshell section (mode control, filter box, spotlight, machine
  // groups, comms) lives in `RailSubshells`. Two things stay HERE because
  // that section unmounts while collapsed: the ref (the desktop ⌘F flow
  // below is rail chrome, and the input exists only while the section is
  // expanded) and the filter query itself — pre-extraction the query lived
  // in AppSidebar, and a review caught the lift to the child silently
  // losing the typed text across a collapse. Persistence is the parent's job.
  const filterRef = useRef<HTMLInputElement>(null);
  const [subshellQuery, setSubshellQuery] = useState("");
  // Sections folded away by their eye toggle (operator ask 2026-09-27). The
  // storage SHAPE and the transitions live in `lib/sidebar-section-hidden-pref`;
  // the state stays here because a press must re-render the rail.
  const [hiddenSections, setHiddenSections] = useState<Record<string, boolean>>(readHiddenSections);
  const toggleSectionHidden = useCallback((id: string) => {
    setHiddenSections((prev) => {
      const next = toggleHidden(prev, id);
      writeHiddenSections(next);
      return next;
    });
  }, []);
  // Forces a section SHOWN (never toggles), so ⌘F can reveal a hidden rail
  // before it tries to focus the filter inside it.
  const revealSection = useCallback((id: string) => {
    setHiddenSections((prev) => {
      const next = revealHidden(prev, id);
      if (next !== prev) writeHiddenSections(next);
      return next;
    });
  }, []);
  const isSectionHidden = (id: string) => hiddenSections[id] === true;
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
            // Reveal the rail both ways it might be out of view — the whole-
            // sidebar collapse, and this section's own eye — before waiting for
            // the input to mount.
            setFocusFilterWhenOpen(true);
            setCollapsed(false);
            revealSection("subshells");
          }
        }
      }),
    [toggle, revealSection],
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
            // Detail pages count: /nodes/local is inside the Nodes page, so
            // the group that holds Nodes is open there (spec 2026-10-07 §A).
            // Segment-aware on purpose: a bare startsWith would also match a
            // sibling route that merely begins with the same letters.
            const childActive = entry.children.some(
              (child) => location.pathname === child.to || location.pathname.startsWith(`${child.to}/`),
            );
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
                {/* Each of these two sections carries an EYE (operator ask
                    2026-09-27) that folds its whole list away, so a long
                    Subshells/Workspaces list cannot push the sections below out
                    of reach. It sits left of the section's +. */}
                {!collapsed && item.to === "/workspaces" && (
                  <RailSectionActions
                    addTooltip="New workspace"
                    onAdd={() => {
                      quickAdd.openNewWorkspace();
                      onQuickAdd?.();
                    }}
                    hidden={isSectionHidden("workspaces")}
                    showTooltip="Show workspaces"
                    hideTooltip="Hide workspaces"
                    onToggleHidden={() => toggleSectionHidden("workspaces")}
                  />
                )}
                {!collapsed && item.to === "/" && (
                  <RailSectionActions
                    addTooltip="New subshell"
                    onAdd={() => {
                      quickAdd.openLaunch();
                      onQuickAdd?.();
                    }}
                    hidden={isSectionHidden("subshells")}
                    showTooltip="Show subshells"
                    hideTooltip="Hide subshells"
                    onToggleHidden={() => toggleSectionHidden("subshells")}
                  />
                )}
              </div>
              {/* The whole subshell section — mode control, filter, the
                  Needs Attention spotlight, the machine groups and the
                  cross-agent comms — is `RailSubshells`, which owns that
                  shape and its localStorage prefs. The ONE thing staying
                  here is the filter query: this mount unmounts on collapse,
                  and the query outlives it (see its prop JSDoc). It stays
                  hidden exactly where it always was: collapsed has no room
                  for any of it. */}
              {/* A little air between a SELECTED nav pill and the list under it,
                  so the highlight's bottom edge does not sit flush on the first
                  row (operator ask 2026-09-27). Only while the item is the
                  active route — an unselected pill carries no fill to separate. */}
              {!collapsed && item.to === "/" && !isSectionHidden("subshells") && (
                <div className={location.pathname === "/" ? "mt-1.5" : undefined}>
                  <RailSubshells filterRef={filterRef} query={subshellQuery} onQueryChange={setSubshellQuery} />
                </div>
              )}
              {/* The Workspaces rail body (search, Saved, Drafts) lives in its
                  own component; it renders nothing when there is nothing to
                  show, which is the same promise the old inline block made. */}
              {!collapsed && item.to === "/workspaces" && !isSectionHidden("workspaces") && <WorkspacesSection />}
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
