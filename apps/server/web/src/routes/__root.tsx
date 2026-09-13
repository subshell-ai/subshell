import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { useMemo } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DesktopBridge } from "@/components/desktop/desktop-bridge";
import { DesktopNotifications } from "@/components/desktop/desktop-notifications";
import { DesktopSidebar } from "@/components/desktop/desktop-sidebar";
import { EmergencyLoginBanner } from "@/components/emergency-login-banner";
import { MobileTopBar } from "@/components/mobile-top-bar";
import { OfflineBanner } from "@/components/offline-banner";
import { QuickAddProvider } from "@/components/quick-add";
import { RouteError } from "@/components/route-error";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { useDesktopShellReady } from "@/hooks/use-desktop-shell-ready";
import { useHasSidebar } from "@/hooks/use-has-sidebar";
import { LiveSubshellsFeedProvider } from "@/hooks/use-live-subshells-feed";
import { useServerOffline } from "@/hooks/use-server-offline";
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets";
import { apiFetch } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth";
import { isDesktop } from "@/lib/desktop";
import { queryClient } from "@/lib/query-client";
import { shellGate } from "@/lib/shell-gate";

export const Route = createRootRoute({
  component: RootComponent,
  // A route crash used to land on TanStack's DEFAULT screen: unstyled, under
  // the phone status bar, no escape (2026-09-04). This one is safe-area aware
  // and auto-recovers from the common cause (stale lazy chunk after a deploy).
  errorComponent: RouteError,
});

/**
 * The provider stack only. The auth guard hooks deliberately live in `Shell`,
 * NOT here: `useCurrentUser`/`useQuery` called above `QueryClientProvider`
 * would sit outside the provider and throw "No QueryClient set".
 */
function RootComponent() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

/** Stable-identity redirect element — see the gate note in `Shell`. */
const NAVIGATE_TO_SETUP = <Navigate to="/setup" />;

/**
 * The guarded app frame: everything below the providers. Responsive shell
 * (spec §3): at/above the tiling breakpoint the classic sidebar layout; below
 * it the drawer's hamburger (MobileNav) rides in each page's own header where
 * one exists, with a slim fallback bar for the pages that have none — one nav
 * implementation, shared drawer. Safe-area padding lives here so no page has
 * to know about the notch.
 *
 * Soft-keyboard pinning (spec §5) also lives here: sizing/transforming the
 * WHOLE shell to the visible viewport keeps every descendant's
 * percentage/flex height (pages use `h-full`) correct without each page
 * having to subtract the top bar and key bar itself. The `h-dvh` class is the
 * fallback whenever insets are null (desktop, browsers without the API).
 *
 * The signed-out guard holds first paint until the session (and, when signed
 * out, the setup state) is known so chrome never flashes, then redirects:
 * first-run takes precedence — while the instance has no users everyone lands
 * on `/setup` (the boot wizard, never a sign-in form that cannot work) —
 * otherwise every non-bare route bounces to `/login?redirect=<path>`. The
 * pre-auth pages (`/login`, `/setup`) are "bare": they own the whole frame,
 * so the sidebar and mobile top bar never mount on them. If the setup-status
 * query fails, `needsSetup` stays undefined, no redirect fires, and the page
 * renders as before (the old behavior) — a later navigation retries the query.
 */
function Shell() {
  const hasSidebar = useHasSidebar();
  // Read from the User-Agent, so it is settled before first paint — no IPC
  // handshake to race, and it survives the hard navigations at sign-out and
  // after sign-in.
  const desktop = isDesktop();
  // Tells the shell it may drop the title bar and SHOW the window. It has to
  // run before every gate below: `/login` and `/setup` are `bare`, so they
  // render no sidebar at all — and those are exactly the routes a first launch
  // lands on. Hooks run before the early returns, which is what makes this the
  // right home for it.
  useDesktopShellReady(desktop);
  const insets = useVisualViewportInsets();
  const { data: user, isLoading } = useCurrentUser();
  const offline = useServerOffline();
  const location = useLocation();
  // Pre-auth pages own the whole frame: no sidebar, no drawer bar.
  const bare = location.pathname === "/login" || location.pathname === "/setup";
  // First-run precedence: with no users yet, signed-out visitors go to the
  // wizard (the boot experience), never to a sign-in form that cannot work.
  // Cached hard — needsSetup is true exactly once in an instance's life.
  // The result keeps the full `{ needsSetup }` shape: / and /setup observe the
  // same query key and read the object, so the cache must hold one shape.
  const { data: setupStatus, isLoading: setupLoading } = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => apiFetch<{ needsSetup: boolean }>("/api/setup/status"),
    enabled: !isLoading && !user,
    staleTime: Infinity,
  });
  const needsSetup = setupStatus?.needsSetup;
  // See the gate below: the redirect elements need identities stable across
  // renders, so the one that carries per-location state is memoized on the
  // only input it reads.
  const loginRedirect = useMemo(
    () => <Navigate to="/login" search={{ redirect: location.pathname }} />,
    [location.pathname],
  );

  // The whole first-paint / signed-out guard is the tested lib/shell-gate.ts
  // predicate (regressions #7/#8: a down server must be an offline notice,
  // never a blank screen, and never a bounce to an unreachable /login).
  const gate = shellGate({
    isLoading,
    hasUser: !!user,
    offline,
    setupLoading,
    needsSetup,
    bare,
    pathname: location.pathname,
  });
  if (gate === "blank" || gate === "holdSetup") return null;
  if (gate === "offlineHold") return <OfflineBanner />;
  // The redirect elements MUST keep a stable identity across renders:
  // <Navigate> diffs its props by reference and re-navigates whenever they
  // change, and each navigation re-renders this component — inline JSX here
  // is a fresh element every render, which hangs the tab in a
  // render→navigate→render storm (fresh-instance redirect, 2026-09-03).
  if (gate === "toSetup") return NAVIGATE_TO_SETUP;
  if (gate === "toLogin") return loginRedirect;

  return (
    <QuickAddProvider>
      {/* Inside the provider on purpose — the bridge opens the quick-add
        dialogs, and a hook called in this component's own body would sit
        above the context it needs.

        Signed-in only, like every other child of this frame. It used to carry
        `desktop &&` alone, and the gate returns "render" on /setup and /login
        (those pages must paint) — so on a brand-new instance the tray's "New
        Subshell" opened the quick-add dialog over the setup wizard. A dialog
        is not a route, so no route gate had anything to say about it. */}
      {desktop && !!user && !bare && <DesktopBridge />}
      <div
        className="flex h-dvh flex-col overflow-hidden pt-[env(safe-area-inset-top)]"
        style={insets ? { height: `${insets.heightPx}px`, transform: `translateY(${insets.offsetYpx}px)` } : undefined}
      >
        {!bare && <OfflineBanner />}
        {/* Signed-in only: the pre-auth pages ARE the lockout surface. Above
          the top bar so the warning spans the full width (spec §6 banner). */}
        {user && <EmergencyLoginBanner />}
        {!hasSidebar && !bare && <MobileTopBar />}
        {/* The live feed covers everything below it — sidebar dots, home cards,
          pickers — for the whole signed-in session (spec 2026-09-03 §6). The
          enabled gate keeps its token POST away from /login and /setup. */}
        <LiveSubshellsFeedProvider enabled={!!user && !bare}>
          {/* Inside the feed and behind the same gate: it reads the live
            subshell list, and above them it would fire an unauthenticated
            /api/subshells on the login screen. */}
          {desktop && !!user && !bare && <DesktopNotifications />}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* One branch, deliberately: everything else in this frame —
              the banners, the feed provider, the viewport pinning, the outlet
              — is identical in both shells, and the rail differs only in
              chrome (see components/desktop/desktop-sidebar.tsx). A desktop
              window can be dragged below SIDEBAR_MIN_WIDTH (its floor is 360),
              so MobileTopBar does mount there — the drawer is the right chrome
              once the rail would cost a third of the window. */}
            {hasSidebar && !bare && (desktop ? <DesktopSidebar /> : <AppSidebar />)}
            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              <Outlet />
            </div>
          </div>
        </LiveSubshellsFeedProvider>
      </div>
    </QuickAddProvider>
  );
}
