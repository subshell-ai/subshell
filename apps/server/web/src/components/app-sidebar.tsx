import { Button, cn } from "@internal/node-admin";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ExternalLink,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Smartphone,
  TerminalSquare,
  UserRound,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AboutDialog } from "@/components/about-dialog";
import { ActiveWorkspaceSection } from "@/components/sidebar/active-workspace-section";
import { AllSubshellsSection } from "@/components/sidebar/all-subshells-section";
import { ContextNavigation } from "@/components/sidebar/context-navigation";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useClockTick } from "@/hooks/use-clock-tick";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useUpdates } from "@/hooks/use-updates";
import { useCurrentUser } from "@/lib/auth";
import { desktopInvoke, isDesktop, onDesktopAction } from "@/lib/desktop";
import { workspaceIdFromPath } from "@/lib/route-ids";
import { type SidebarSection, sidebarSection } from "@/lib/sidebar-context";
import { ACTIVITY_TICK_MS } from "@/lib/subshell-indicator";

const COLLAPSED_KEY = "subshell.sidebarCollapsed";
const SECTIONS = [
  { id: "workspaces", label: "Workspaces", to: "/workspaces", icon: LayoutDashboard },
  { id: "subshells", label: "Subshells", to: "/subshells", icon: TerminalSquare },
  { id: "mobile", label: "Subshell for Mobile", to: "/mobile", icon: Smartphone },
  { id: "settings", label: "Settings", to: "/nodes", icon: Settings },
  { id: "account", label: "Account", to: "/account", icon: UserRound },
] as const;

/** Global section rail beside route-specific navigation, shared by browser and desktop. */
export function AppSidebar({
  forceExpanded = false,
  className,
  headerEnd,
  headerAbove,
  footerEnd,
  onQuickAdd,
  onSectionNavigate,
  onSectionNavigated,
  variant = "web",
}: {
  forceExpanded?: boolean;
  className?: string;
  /** The mobile drawer's close control. */
  headerEnd?: ReactNode;
  /** Native desktop drag strip, above both rails. */
  headerAbove?: ReactNode;
  /** Close the mobile drawer when a root-owned launch dialog opens. */
  onQuickAdd?: () => void;
  /** Let the drawer stay open while its navigation context changes. */
  onSectionNavigate?: () => void;
  onSectionNavigated?: () => void;
  /** Desktop connection and update controls retain their collapsed presentation. */
  footerEnd?: (ctx: { collapsed: boolean }) => ReactNode;
  variant?: "web" | "desktop";
}) {
  useClockTick(ACTIVITY_TICK_MS);
  const location = useLocation();
  const navigate = useNavigate();
  const routeSection = sidebarSection(location.pathname);
  const workspaceId = workspaceIdFromPath(location.pathname);
  const [panel, setPanel] = useState<{ path: string; section: "workspaces" | "subshells" } | null>(null);
  const section = workspaceId && panel?.path === location.pathname ? panel.section : routeSection;
  const { data: user } = useCurrentUser();
  const { data: publicSettings } = usePublicSettings();
  const isAdmin = publicSettings?.viewerIsAdmin === true;
  const { data: updates } = useUpdates(isAdmin);
  const updateNotice = updates?.server?.updateAvailable ? (updates.server.latest?.version ?? null) : null;
  const [aboutOpen, setAboutOpen] = useState(false);
  const [collapsedState, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const collapsed = !forceExpanded && collapsedState;
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const restoreToggleFocus = useRef(false);
  useEffect(() => {
    if (!restoreToggleFocus.current) return;
    toggleButtonRef.current?.focus();
    restoreToggleFocus.current = false;
  });
  const [subshellQuery, setSubshellQuery] = useState("");
  const [focusPending, setFocusPending] = useState(false);
  // Remember route destinations independently from the workspace’s sidebar
  // panel, so browsing subshells cannot replace the saved dashboard URL.
  const destinations = useRef<Partial<Record<SidebarSection, { pathname: string; search: Record<string, unknown> }>>>(
    {},
  );
  useEffect(() => {
    destinations.current[routeSection] = { pathname: location.pathname, search: location.search };
  }, [routeSection, location.pathname, location.search]);
  const toggle = useCallback(
    () =>
      setCollapsed((previous) => {
        const next = !previous;
        try {
          localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
        } catch {
          /* Keep the in-memory preference when storage is unavailable. */
        }
        return next;
      }),
    [],
  );
  useEffect(
    () =>
      onDesktopAction((action) => {
        if (action === "toggle-sidebar") toggle();
        if (action === "focus-filter") {
          void navigate({ to: "/subshells" }).then(() => setFocusPending(true));
        }
      }),
    [toggle, navigate],
  );
  useEffect(() => {
    if (!focusPending) return;
    const focusSearch = () => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search subshells"]');
      if (!input) return false;
      input.focus();
      setFocusPending(false);
      return true;
    };
    if (focusSearch()) return;
    // The route can finish navigation before its lazy page mounts the search.
    const observer = new MutationObserver(() => {
      if (focusSearch()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [focusPending]);

  const sidebarToggle = (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={toggleButtonRef}
              variant="ghost"
              size="icon"
              onClick={() => {
                restoreToggleFocus.current = true;
                toggle();
              }}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          }
        />
        <TooltipContent side="right">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <aside
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col border-border border-r bg-card transition-[width] duration-200",
        collapsed ? "w-14" : variant === "desktop" ? "w-76" : "w-72",
        className,
      )}
    >
      {headerAbove}
      <div className="flex min-h-0 flex-1">
        <TooltipProvider delay={200}>
          <nav
            aria-label="Main sections"
            className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-border border-r bg-background px-1 py-3"
          >
            {collapsed ? (
              <div className="mb-2 flex size-11 items-center justify-center">{sidebarToggle}</div>
            ) : (
              <Link to="/" aria-label="Subshell" className="mb-2 flex size-11 items-center justify-center">
                <img src="/icons/mark-80.png" alt="" className="h-6 w-auto" />
              </Link>
            )}
            {SECTIONS.map((item) => {
              const remembered =
                routeSection === item.id
                  ? { pathname: location.pathname, search: location.search }
                  : destinations.current[item.id];
              // The landing route can redirect to Subshells when no workspace exists.
              const destination = item.id === "workspaces" && remembered?.pathname === "/" ? undefined : remembered;
              return (
                <div key={item.id} className={cn(item.id === "mobile" && "mt-auto pt-6")}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Link
                          to={(destination?.pathname ?? item.to) as never}
                          search={(destination?.search ?? {}) as never}
                          aria-label={item.label}
                          aria-current={section === item.id ? "true" : undefined}
                          onClick={(event) => {
                            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                              return;
                            if (!forceExpanded && section === item.id) {
                              event.preventDefault();
                              toggle();
                              return;
                            }
                            if (collapsed) toggle();
                            if (workspaceId && (item.id === "workspaces" || item.id === "subshells")) {
                              event.preventDefault();
                              setPanel({ path: location.pathname, section: item.id });
                              return;
                            }
                            setPanel(null);
                            if (!onSectionNavigate || section === item.id) return;
                            event.preventDefault();
                            onSectionNavigate();
                            void navigate({
                              to: (destination?.pathname ?? item.to) as never,
                              search: (destination?.search ?? {}) as never,
                            }).finally(() => onSectionNavigated?.());
                          }}
                          className={cn(
                            "relative flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
                            section === item.id && "bg-accent text-accent-foreground",
                          )}
                        >
                          <item.icon className="size-5" />
                          {item.id === "account" && updateNotice && (
                            <span
                              role="img"
                              aria-label="Update available"
                              className="absolute top-1 right-1 size-2 rounded-full bg-warning"
                            />
                          )}
                        </Link>
                      }
                    />
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
            {isDesktop() && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Open in browser"
                      onClick={() =>
                        void desktopInvoke("desktop_open_in_browser", {
                          path: `${location.pathname}${location.searchStr}`,
                        })
                      }
                    >
                      <ExternalLink />
                    </Button>
                  }
                />
                <TooltipContent side="right">Open in browser</TooltipContent>
              </Tooltip>
            )}
          </nav>
        </TooltipProvider>
        {!collapsed && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
              <h2 className="min-w-0 font-strong text-label">{SECTIONS.find((item) => item.id === section)?.label}</h2>
              {!forceExpanded && sidebarToggle}
              {headerEnd}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-1 pb-3">
              {section === "workspaces" ? (
                <ActiveWorkspaceSection onQuickAdd={onQuickAdd} />
              ) : section === "subshells" ? (
                <AllSubshellsSection
                  query={subshellQuery}
                  onQueryChange={setSubshellQuery}
                  workspaceId={workspaceId ?? undefined}
                  onAction={onQuickAdd}
                />
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
        )}
      </div>
      {footerEnd && <div className="border-border border-t p-2">{footerEnd({ collapsed })}</div>}
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </aside>
  );
}
