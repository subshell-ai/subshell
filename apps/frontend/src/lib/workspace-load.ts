import { ApiError } from "@/lib/api";

/** The four truths the workspace detail page renders one of. */
export type WorkspaceLoad = "loading" | "answeredError" | "notFound" | "ready";

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
 *  - "ready"          → last-good detail wins over any background error, so a
 *    blip never unmounts the dock and tears down every pane's terminal.
 */
export function workspaceLoad(args: { isLoading: boolean; detail: unknown; error: unknown }): WorkspaceLoad {
  const { isLoading, detail, error } = args;
  const answeredStatus = error instanceof ApiError ? error.status : null;
  const notFound = !detail && answeredStatus === 404;
  const answeredError = !detail && answeredStatus !== null && answeredStatus !== 404;
  if (isLoading || (!detail && !notFound && !answeredError)) return "loading";
  if (answeredError) return "answeredError";
  if (!detail) return "notFound";
  return "ready";
}
