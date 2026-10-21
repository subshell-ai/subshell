import { Button, cn } from "@internal/node-admin";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ExternalLink, Settings, Smartphone } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AboutDialog } from "@/components/about-dialog";
import { MobileInstallDialog } from "@/components/mobile-install-dialog";
import { ActiveWorkspaceSection } from "@/components/sidebar/active-workspace-section";
import { ContextNavigation } from "@/components/sidebar/context-navigation";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { UserMenu } from "@/components/user-menu";
import { useClockTick } from "@/hooks/use-clock-tick";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useUpdates } from "@/hooks/use-updates";
import { signOutAndRedirect, useCurrentUser } from "@/lib/auth";
import { desktopInvoke, isDesktop, onDesktopAction } from "@/lib/desktop";
import { workspaceIdFromPath } from "@/lib/route-ids";
import { type SidebarSection, sidebarSection } from "@/lib/sidebar-context";
import { ACTIVITY_TICK_MS } from "@/lib/subshell-indicator";

/**
 * The bar's cells, in order. Only Workspaces and Settings are links: Subshell
 * for Mobile opens the install dialog and Account opens the profile card, so
 * those carry no `to`, no active state, and no remembered destination. The
 * header still reads the labels from here for the other panel sections.
 * Workspaces renders the Subshell mark rather than a lucide glyph, the way
 * the old collapsed rail's logo cell did; its link entry carries no icon.
 */
const SECTIONS = [
  { id: "workspaces", label: "Workspaces", to: "/workspaces" },
  { id: "mobile", label: "Subshell for Mobile", icon: Smartphone },
  { id: "settings", label: "Settings", to: "/nodes", icon: Settings },
  { id: "account", label: "Account" },
] as const;

/**
 * The sidebar panel, shared by browser, desktop shells and the mobile drawer:
 * the route's own navigation fills the panel, and the section cells dock as a
 * horizontal bar at its bottom (`aria-label="Main sections"`, the name the
 * drawer's close logic and the e2e specs select): the Workspaces and Settings
 * links, the cell that opens the Subshell for Mobile dialog, and the Account
 * profile card. "Open in browser" joins that bar only inside a desktop shell.
 */
export function AppSidebar({
  className,
  headerEnd,
  headerAbove,
  footerEnd,
  onQuickAdd,
  onSectionNavigate,
  onSectionNavigated,
  variant = "web",
}: {
  className?: string;
  /** The mobile drawer's close control. */
  headerEnd?: ReactNode;
  /** Native desktop drag strip, above the panel. */
  headerAbove?: ReactNode;
  /** Close the mobile drawer when a root-owned launch dialog opens. */
  onQuickAdd?: () => void;
  /** Let the drawer stay open while its navigation context changes. */
  onSectionNavigate?: () => void;
  onSectionNavigated?: () => void;
  /** Desktop rows under the section bar. */
  footerEnd?: () => ReactNode;
  variant?: "web" | "desktop";
}) {
  useClockTick(ACTIVITY_TICK_MS);
  const location = useLocation();
  const navigate = useNavigate();
  const routeSection = sidebarSection(location.pathname);
  const workspaceId = workspaceIdFromPath(location.pathname);
  const section = routeSection === "subshells" ? "workspaces" : routeSection;
  const { data: user } = useCurrentUser();
  const { data: publicSettings } = usePublicSettings();
  const isAdmin = publicSettings?.viewerIsAdmin === true;
  const { data: updates } = useUpdates(isAdmin);
  const updateNotice = updates?.server?.updateAvailable ? (updates.server.latest?.version ?? null) : null;
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [focusPending, setFocusPending] = useState(false);
  // Remember each section’s last destination without replacing the workspace
  // destination when its dashboard is opened.
  const destinations = useRef<Partial<Record<SidebarSection, { pathname: string; search: Record<string, unknown> }>>>(
    {},
  );
  useEffect(() => {
    destinations.current[routeSection] = { pathname: location.pathname, search: location.search };
  }, [routeSection, location.pathname, location.search]);
  useEffect(
    () =>
      onDesktopAction((action) => {
        if (action === "focus-filter") {
          void navigate({ to: "/subshells" }).then(() => setFocusPending(true));
        }
      }),
    [navigate],
  );
  useEffect(() => {
    if (!focusPending) return;
    const focusSearch = () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search subshells"]');
      if (!input || input.closest("[hidden]")) return false;
      input.focus();
      setFocusPending(false);
      return true;
    };
    if (focusSearch()) return;
    // The route can finish navigation before its lazy page mounts the search.
    const observer = new MutationObserver(() => {
      if (focusSearch()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, [focusPending]);

  return (
    <aside
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col border-border border-r bg-card",
        // Both drop the 56px icon rail retired this branch. The desktop shell keeps
        // 48px instead of 56: its bar carries a fifth button ("Open in browser").
        // The widths size to the worst case, the 44px touch cell: 5 cells plus gaps
        // and padding need 252px, which w-62 would clip. A fine pointer's 36px
        // cells need far less.
        variant === "desktop" ? "w-64" : "w-58",
        className,
      )}
    >
      {headerAbove}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {section !== "workspaces" && (
          <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
            <h2 className="min-w-0 font-strong text-label">{SECTIONS.find((item) => item.id === section)?.label}</h2>
            {headerEnd}
          </div>
        )}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-4 px-2 pb-3",
            section === "workspaces" ? "overflow-hidden pt-3" : "overflow-y-auto pt-1",
          )}
        >
          {section === "workspaces" ? (
            <ActiveWorkspaceSection onQuickAdd={onQuickAdd} headerEnd={headerEnd} />
          ) : (
            <ContextNavigation section={section} isAdmin={isAdmin} onAbout={() => setAboutOpen(true)} />
          )}
          {section === "account" && (
            <div className="mt-auto flex min-w-0 flex-col gap-1 border-t px-3 pt-4 text-detail text-muted-foreground">
              <p className="break-words font-strong text-foreground">
                {user?.name?.trim() || user?.email || "Signed in"}
              </p>
              {user?.email && <p className="break-all">{user.email}</p>}
              {publicSettings?.serverVersion && <p>Subshell Server {publicSettings.serverVersion}</p>}
              {publicSettings?.instanceName && <p className="break-words">{publicSettings.instanceName}</p>}
              {isAdmin && updateNotice && (
                <Link to="/settings/updates" className="mt-2 rounded-md py-2 text-warning hover:underline">
                  Update available: v{updateNotice}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
      <TooltipProvider delay={200}>
        {/* The bar's cells stay 44px on touch pointers: the phone drawer shares
            this exact bar, and 44px is its tap target. A fine pointer gets 36px
            cells, which pulls the bar from 53px to 45px. */}
        <nav
          aria-label="Main sections"
          className="flex shrink-0 items-center justify-center gap-1 border-border border-t px-2 py-1"
        >
          {SECTIONS.map((item) => {
            // This cell opens a dialog, so it is never "where you are": no
            // active state, no remembered destination, no navigation.
            if (item.id === "mobile")
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={item.label}
                        onClick={() => setMobileOpen(true)}
                        className="relative flex pointer-fine:size-9 size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        <item.icon className="size-5" />
                      </button>
                    }
                  />
                  <TooltipContent side="top">{item.label}</TooltipContent>
                </Tooltip>
              );
            // The card names the person, so this cell carries no tooltip; the
            // avatar's own amber dot (inside UserMenu) is the update notice.
            if (item.id === "account")
              return (
                <UserMenu
                  key={item.id}
                  name={user?.name ?? ""}
                  email={user?.email ?? ""}
                  barCell
                  serverVersion={publicSettings?.serverVersion ?? ""}
                  instanceName={publicSettings?.instanceName ?? ""}
                  updateNotice={updateNotice}
                  onOpenUpdates={isAdmin ? () => void navigate({ to: "/settings/updates" }) : undefined}
                  onPreferences={() => void navigate({ to: "/preferences" })}
                  onAccountSettings={() => void navigate({ to: "/account" })}
                  onAbout={() => setAboutOpen(true)}
                  onSignOut={() => void signOutAndRedirect()}
                />
              );
            const remembered =
              routeSection === item.id
                ? { pathname: location.pathname, search: location.search }
                : destinations.current[item.id];
            // The landing route can redirect to Subshells when no workspace exists.
            const destination = item.id === "workspaces" && remembered?.pathname === "/" ? undefined : remembered;
            const active = section === item.id;
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger
                  render={
                    <Link
                      to={(destination?.pathname ?? item.to) as never}
                      search={(destination?.search ?? {}) as never}
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                      onClick={(event) => {
                        // Modifier and middle clicks belong to the real link.
                        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                          return;
                        // Inside a workspace, Workspaces is where you are.
                        if (workspaceId && item.id === "workspaces") {
                          event.preventDefault();
                          return;
                        }
                        if (!onSectionNavigate || active) return;
                        event.preventDefault();
                        onSectionNavigate();
                        void navigate({
                          to: (destination?.pathname ?? item.to) as never,
                          search: (destination?.search ?? {}) as never,
                        }).finally(() => onSectionNavigated?.());
                      }}
                      className={cn(
                        "relative flex pointer-fine:size-9 size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
                        active && "bg-accent text-accent-foreground",
                      )}
                    >
                      {item.id === "workspaces" ? (
                        // The mark the old collapsed rail wore, now on the bar
                        // cell; the link's aria-label names it, so the image
                        // is decorative. `h-6 w-auto`: 24px tall, the height
                        // the old rail drew this asset at, with the width
                        // following the 30x40 aspect. No `size-*` box ever,
                        // which would squash the /S wide (ruling 2026-10-20,
                        // measured on the live bar).
                        <img
                          src="/icons/mark-40.png"
                          srcSet="/icons/mark-80.png 2x, /icons/mark-120.png 3x"
                          alt=""
                          className="h-6 w-auto"
                        />
                      ) : (
                        <item.icon className="size-5" />
                      )}
                    </Link>
                  }
                />
                <TooltipContent side="top">{item.label}</TooltipContent>
              </Tooltip>
            );
          })}
          {isDesktop() && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="pointer-fine:size-9 size-11"
                    aria-label="Open in browser"
                    onClick={() =>
                      void desktopInvoke("desktop_open_in_browser", {
                        path: `${location.pathname}${location.searchStr}`,
                      })
                    }
                  >
                    <ExternalLink className="size-5" />
                  </Button>
                }
              />
              <TooltipContent side="top">Open in browser</TooltipContent>
            </Tooltip>
          )}
        </nav>
      </TooltipProvider>
      {footerEnd && <div className="border-border border-t p-2">{footerEnd()}</div>}
      {/* Both overlays mount at the panel root: the menu item or the bar cell
          that raises them must not lose the dialog the way a dialog mounted
          in a closing menu would. */}
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <MobileInstallDialog open={mobileOpen} onOpenChange={setMobileOpen} />
    </aside>
  );
}
