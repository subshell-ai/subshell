import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ProfileRow } from "@/types/profile";

/** Query key for the caller's profiles, shared by every mutation site. */
export const PROFILES_QUERY_KEY = ["profiles"] as const;

/**
 * Shared query for the authenticated user's profiles. Every page that lists
 * profiles reads through this hook so a single `PROFILES_QUERY_KEY`
 * invalidation refreshes them all (prefix match covers the `node=any`
 * variant's key too).
 * @param opts.node - `"any"` lists profiles regardless of LOCAL harness
 *   state (the launch picker pairs them against every node from the node
 *   views; spec 2026-09-02 §4a). Default: the local filter.
 */
export function useProfiles(opts: { node?: "any" } = {}) {
  // One local so the cache-key segment and the wire string can never drift.
  const node = opts.node;
  return useQuery({
    queryKey: node === undefined ? PROFILES_QUERY_KEY : ([...PROFILES_QUERY_KEY, "node", node] as const),
    queryFn: () => apiFetch<ProfileRow[]>(node === undefined ? "/api/profiles" : `/api/profiles?node=${node}`),
  });
}

/**
 * Invalidates the profile list. Keeps the key in one place the way
 * `use-workspaces` does, for every place profiles are created or deleted.
 */
export function useInvalidateProfiles(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
}
