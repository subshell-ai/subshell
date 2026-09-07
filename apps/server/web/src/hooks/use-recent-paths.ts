import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** One recently used working directory, as recorded by subshell creation. */
export interface RecentPath {
  /** Absolute directory path. */
  path: string;
  /** Display label (the subshell name it was last used with), if any. */
  label: string | null;
}

/**
 * The caller's recently used working directories (newest first), recorded
 * whenever a subshell is created. Feeds the new-subshell form's pre-fill; the
 * folder picker gets the same list inside every explore response.
 * @param nodeId - Launch node to scope the list to. The server records each
 *                 subshell-create touch under the subshell's resolved node and
 *                 filters `/recent` by this param; omitted (or `local`) means
 *                 the control-plane host, byte-identical to the pre-nodes
 *                 request. A node the caller cannot see answers 404, so the
 *                 param is only worth sending for ids from the node list.
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
