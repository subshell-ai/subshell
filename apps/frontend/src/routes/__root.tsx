import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { EmergencyLoginBanner } from "@/components/emergency-login-banner";
import { MobileTopBar } from "@/components/mobile-top-bar";
import { OfflineBanner } from "@/components/offline-banner";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ViewportDebug } from "@/components/viewport-debug";
import { useIsWide } from "@/hooks/use-is-wide";
import { useServerOffline } from "@/hooks/use-server-offline";
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets";
import { apiFetch } from "@/lib/api";
import { useCurrentUser } from "@/lib/auth";
import { maybeResetViewport } from "@/lib/ios-viewport-reset";
import { queryClient } from "@/lib/query-client";
import { shellGate } from "@/lib/shell-gate";

export const Route = createRootRoute({
  component: RootComponent,
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
  const wide = useIsWide();
  const insets = useVisualViewportInsets();
  // iOS standalone mode can boot already broken: WebKit's auto-zoom (armed
  // by focusing any sub-16px input) persists its scale and the shrunken
  // layout height across app kills, leaving a dead band under the key bar
  // that no CSS inside the webview can fix. Heal at launch and whenever the
  // visual viewport moves while the scale is stuck above 1.
  useEffect(() => {
    const vv = window.visualViewport;
    const heal = () => maybeResetViewport(vv?.scale ?? window.visualViewport?.scale ?? 1);
    heal();
    vv?.addEventListener("resize", heal);
    vv?.addEventListener("scroll", heal);
    return () => {
      vv?.removeEventListener("resize", heal);
      vv?.removeEventListener("scroll", heal);
    };
  }, []);
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
  if (gate === "toSetup") return <Navigate to="/setup" />;
  if (gate === "toLogin") return <Navigate to="/login" search={{ redirect: location.pathname }} />;

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden pt-[env(safe-area-inset-top)]"
      style={insets ? { height: `${insets.heightPx}px`, transform: `translateY(${insets.offsetYpx}px)` } : undefined}
    >
      {!bare && <OfflineBanner />}
      {/* Signed-in only: the pre-auth pages ARE the lockout surface. Above
          the top bar so the warning spans the full width (spec §6 banner). */}
      {user && <EmergencyLoginBanner />}
      {!wide && !bare && <MobileTopBar />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {wide && !bare && <AppSidebar />}
        <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          <Outlet />
        </div>
      </div>
      {(new URLSearchParams(location.search).has("viewport-debug") ||
        window.matchMedia("(display-mode: standalone)").matches) && <ViewportDebug />}
    </div>
  );
}
