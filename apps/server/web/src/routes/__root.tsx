import { apiFetch } from "@internal/node-admin";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DesktopBridge } from "@/components/desktop/desktop-bridge";
import { DesktopNotifications } from "@/components/desktop/desktop-notifications";
import { DesktopSidebar } from "@/components/desktop/desktop-sidebar";
import { DragStrip, needsStandaloneDragStrip } from "@/components/desktop/drag-strip";
import { EmergencyLoginBanner } from "@/components/emergency-login-banner";
import { MobileTopBar } from "@/components/mobile-top-bar";
import { OfflineBanner } from "@/components/offline-banner";
import { QuickAddProvider } from "@/components/quick-add";
import { RouteError } from "@/components/route-error";
import { ServerVersionRow } from "@/components/sidebar/server-version-row";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { useDesktopShellReady } from "@/hooks/use-desktop-shell-ready";
import { useHasSidebar } from "@/hooks/use-has-sidebar";
import { LiveSubshellsFeedProvider } from "@/hooks/use-live-subshells-feed";
import { useServerOffline } from "@/hooks/use-server-offline";
import { useSetupProgress } from "@/hooks/use-setup-progress";
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets";
import { useCurrentUser } from "@/lib/auth";
import { desktopPlatform, isServerDesktop } from "@/lib/desktop";
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
  //
  // `isServerDesktop`, not `isDesktop`: everything this flag switches on is
  // Subshell SERVER's chrome. The overlay title bar needs `desktop_shell_ready`
  // and a window that drops its decorations; the rail's pill raises that app's
  // assistant; the notifications go through `desktop_notify`. Subshell Client
  // grants none of the three and keeps a normal title bar, so taking this
  // branch there would leave a window with no title bar and no drag strip —
  // i.e. unmovable.
  const desktop = isServerDesktop();
  // Tells the shell it may drop the title bar and SHOW the window. It has to
  // run before every gate below: `/login` and `/setup` are `bare`, so they
  // render no sidebar at all — and those are exactly the routes a first launch
  // lands on. Hooks run before the early returns, which is what makes this the
  // right home for it.
  useDesktopShellReady(desktop);
  // The browser rail's footer carries the SERVER's version — and, for an
  // admin, a dot when a newer one is published. NOT the app's:
  // `DesktopAppUpdateRow` reports the bundle it runs inside, and a browser is
  // inside no app, which is why this rail had no version line at all until
  // 2026-09-18 — read as a missing feature, and really a missing row.
  // Subshell Client's window takes this branch too, and should: it is pointed
  // at somebody's control plane and has no authority over the server app's
  // build.
  const browserFooter = useCallback(
    ({ collapsed }: { collapsed: boolean }) => <ServerVersionRow collapsed={collapsed} />,
    [],
  );
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
  // The signed-in user's own wizard bookmark (spec 2026-09-16): fetched ONCE
  // per document — enabled only when a user exists, since a bookmark
  // presupposes one and the route answers an anonymous caller with 401 — and
  // cached hard, because the wizard's writes go through the same key. The gate
  // holds first paint until it answers so a resume never flashes the dashboard
  // first, and the wizard reads this cached result as its initial step.
  const { data: setupProgress, isLoading: progressLoading } = useSetupProgress(!!user);
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
    progressLoading,
    resumeSetup: setupProgress?.step != null,
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
        {/* The window's title bar on the routes the rail does not cover.
          `shell_ready` takes the native one away on EVERY route — /login and
          /setup included, which is where a first launch lands — but the strip
          that replaces it lives in the rail, and those routes render none. So
          the first window a person ever sees could not be dragged by its top
          edge. macOS only, matching the rail's own gate: it is the platform
          whose decorations are dropped for the overlay. */}
        {desktop && desktopPlatform() === "macos" && needsStandaloneDragStrip(hasSidebar, bare) && <DragStrip fixed />}
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
            {/* `root-frame-guards.test.ts` finds the line that mounts each
                session-only child and requires the check ON IT, so this stays
                one line and `browserFooter` is hoisted above rather than
                inlined. */}
            {hasSidebar && !bare && (desktop ? <DesktopSidebar /> : <AppSidebar footerEnd={browserFooter} />)}
            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              <Outlet />
            </div>
          </div>
        </LiveSubshellsFeedProvider>
      </div>
    </QuickAddProvider>
  );
}
