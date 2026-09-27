import { ApiError } from "@internal/node-admin";

/** The five truths the workspace detail page renders one of. */
export type WorkspaceLoad = "loading" | "answeredError" | "notFound" | "deleted" | "ready";

/**
 * The workspace page's single load decision, extracted from the route so the
 * three "no detail" states are testable (they are the regression #9 fix:
 * downtime must never read as deletion).
 *
 *  - "notFound"       → ONLY a real 404 answer says "deleted".
 *  - "answeredError"  → an ANSWERED non-404 failure (401/403/500) is a genuine
 *    failure to show — it fails fast, so nothing else would ever clear it.
 *  - "loading"        → no answer yet (in-flight, or a NetworkError the query
 *    layer is retrying unbounded, plus `useWorkspace`'s 5 s poll): hold and let
 *    it heal.
 *  - "deleted"        → a 404 that lands ON a cached detail: the workspace
 *    was deleted while the page stood on it (from the rail, another tab,
 *    another device). "ready" still paints the last-good dock — the blip
 *    rule above cannot tell a 404 from an outage, and here the difference
 *    is not a blip but a fact — while the route LEAVES, to the subshell
 *    view the panes' rows still deserve (operator ruling 2026-09-27: the
 *    page must close out, exactly as a deleted subshell's does).
 *  - "ready"          → last-good detail wins over any background error, so a
 *    blip never unmounts the dock and tears down every pane's terminal.
 *  - (a background 404 WITH detail is "deleted", never "ready"; a background
 *    NON-404 error with detail stays "ready" — the regression #9 rule.)
 */
export function workspaceLoad(args: { isLoading: boolean; detail: unknown; error: unknown }): WorkspaceLoad {
  const { isLoading, detail, error } = args;
  const answeredStatus = error instanceof ApiError ? error.status : null;
  // A 404 is the server's word "gone", whichever side of the cache it lands
  // on; only a NON-404 background error is the outage-regression #9 protects.
  if (answeredStatus === 404 && detail) return "deleted";
  const notFound = !detail && answeredStatus === 404;
  const answeredError = !detail && answeredStatus !== null && answeredStatus !== 404;
  if (isLoading || (!detail && !notFound && !answeredError)) return "loading";
  if (answeredError) return "answeredError";
  if (!detail) return "notFound";
  return "ready";
}
