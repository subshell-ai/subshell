import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ProfileRow } from "@/types/profile";

/** Query key for the caller's profiles, shared by every mutation site. */
export const PROFILES_QUERY_KEY = ["profiles"] as const;

/**
 * Shared query for the authenticated user's profiles. Every page that lists
 * profiles reads through this hook so a single `PROFILES_QUERY_KEY`
 * invalidation refreshes them all.
 */
export function useProfiles() {
  return useQuery({
    queryKey: PROFILES_QUERY_KEY,
    queryFn: () => apiFetch<ProfileRow[]>("/api/profiles"),
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
