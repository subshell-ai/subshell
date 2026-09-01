import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** One recently used working directory, as recorded by session creation. */
export interface RecentPath {
  /** Absolute directory path. */
  path: string;
  /** Display label (the session name it was last used with), if any. */
  label: string | null;
}

/**
 * The caller's recently used working directories (newest first), recorded
 * whenever a session is created. Feeds the new-session form's pre-fill; the
 * folder picker gets the same list inside every explore response.
 * @param nodeId - Launch node to scope the list to; the server IGNORES the
 *                 `node` param until phase-2 per-node recent paths, so the
 *                 default (undefined) stays byte-identical to today's request
 *                 and a provided id only adds the param (and its cache key).
 * @returns The query over `GET /api/files/recent`
 */
export function useRecentPaths(nodeId?: string) {
  return useQuery({
    queryKey: nodeId ? (["recent-paths", nodeId] as const) : (["recent-paths"] as const),
    queryFn: () =>
      apiFetch<{ paths: RecentPath[] }>(
        nodeId ? `/api/files/recent?node=${encodeURIComponent(nodeId)}` : "/api/files/recent",
      ),
  });
}
