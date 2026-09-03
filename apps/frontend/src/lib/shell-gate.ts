/** What `Shell` in `__root.tsx` should paint, given the auth/offline truths. */
export type ShellGate = "blank" | "offlineHold" | "holdSetup" | "toSetup" | "toLogin" | "render";

/**
 * The root frame's first-paint / signed-out guard, extracted from `Shell` so
 * the outage branches are testable. The rules, in order:
 *
 *  - Subshell still loading: normally HOLD (return "blank") so chrome never
 *    flashes — but a DOWN server retries unbounded (query-client.ts), which
 *    would otherwise be a blank screen for the whole outage, so once the
 *    offline store says unreachable, paint the standalone notice instead.
 *    (regression #7)
 *  - No user: a server outage is NOT a sign-out — while offline, render the
 *    frame and let it heal (the retry loop refetches; no reload, no bounce to
 *    a /login whose endpoint is also down). Only a definitive signed-out state
 *    redirects: first run → /setup (the boot wizard), else → /login.
 *    (regression #8)
 */
export function shellGate(args: {
  isLoading: boolean;
  hasUser: boolean;
  offline: boolean;
  setupLoading: boolean;
  needsSetup: boolean | undefined;
  /** Pre-auth page (/login, /setup) — those own the whole frame. */
  bare: boolean;
  pathname: string;
}): ShellGate {
  const { isLoading, hasUser, offline, setupLoading, needsSetup, bare, pathname } = args;
  if (isLoading) return offline ? "offlineHold" : "blank";
  if (!hasUser && !offline) {
    if (setupLoading && !bare) return "holdSetup";
    if (needsSetup && pathname !== "/setup") return "toSetup";
    if (needsSetup === false && !bare) return "toLogin";
  }
  return "render";
}
