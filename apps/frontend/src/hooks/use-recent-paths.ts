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
 * @returns The query over `GET /api/files/recent`
 */
export function useRecentPaths() {
  return useQuery({
    queryKey: ["recent-paths"],
    queryFn: () => apiFetch<{ paths: RecentPath[] }>("/api/files/recent"),
  });
}
