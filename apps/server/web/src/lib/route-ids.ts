/**
 * The id a detail route carries in its path, read from a `useLocation()`
 * pathname. Five spellings in four files asked this question (a regex capture
 * in the Workspaces rail body, a test-then-slice pair in the subshell rail,
 * and the same detail-page regex written inline in the mobile top bar and
 * `app-frame`); they are collected here as one review note from 2026-09-27
 * resolved. The rule: the id is the FIRST segment after the prefix, and
 * anything else reads `null` (the bare list page, a near-miss prefix, a
 * missing segment).
 *
 * `location.searchStr` is never in these strings — TanStack hands the search
 * separately — so no query-aware trimming is needed, and callers who have both
 * still pass only `pathname`.
 */

/** Detail id under a prefix, or null when the path is not a detail page. */
function idUnder(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const id = slash === -1 ? rest : rest.slice(0, slash);
  return id === "" ? null : id;
}

/** The `/workspaces/$id` page's workspace id, or null on any other path. */
export function workspaceIdFromPath(pathname: string): string | null {
  return idUnder(pathname, "/workspaces/");
}

/** The `/subshells/$id` page's subshell id, or null on any other path. */
export function subshellIdFromPath(pathname: string): string | null {
  return idUnder(pathname, "/subshells/");
}

/**
 * Whether this is EITHER detail page. The bare `/subshells` and `/workspaces`
 * lists are not (no id segment). Two surfaces asked this with the same inline
 * regex: `lib/app-frame.ts` (who owns the bottom edge on touch) and the mobile
 * top bar (which stands down on a detail page).
 */
export function isDetailPath(pathname: string): boolean {
  return workspaceIdFromPath(pathname) !== null || subshellIdFromPath(pathname) !== null;
}
