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
 *  - A signed-in user with the wizard bookmark unread holds first paint (same
 *    courtesy the no-users check pays a signed-out visitor), and one whose
 *    bookmark is set is kept ON `/setup` — the resume (spec 2026-09-16). Both
 *    skip offline for the reason the first two rules establish: a read that
 *    cannot answer during an outage must not blank the frame or bounce the
 *    person into a page whose data is also unreachable.
 */
export function shellGate(args: {
  isLoading: boolean;
  hasUser: boolean;
  offline: boolean;
  setupLoading: boolean;
  needsSetup: boolean | undefined;
  /** Pre-auth page (/login, /setup, /pending) — those own the whole frame. */
  bare: boolean;
  pathname: string;
  /** True while the caller's own wizard bookmark has not answered yet. */
  progressLoading: boolean;
  /** True when the caller's bookmark names a step — resume the wizard. */
  resumeSetup: boolean;
}): ShellGate {
  const { isLoading, hasUser, offline, setupLoading, needsSetup, bare, pathname, progressLoading, resumeSetup } = args;
  if (isLoading) return offline ? "offlineHold" : "blank";
  if (hasUser && !offline) {
    if (progressLoading) return "blank";
    if (resumeSetup && pathname !== "/setup") return "toSetup";
  }
  if (!hasUser && !offline) {
    if (setupLoading && !bare) return "holdSetup";
    if (needsSetup && pathname !== "/setup") return "toSetup";
    if (needsSetup === false && !bare) return "toLogin";
  }
  return "render";
}
