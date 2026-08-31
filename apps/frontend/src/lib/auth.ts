import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Fetches the current session (better-auth get-session endpoint).
 * Returns null when unauthenticated.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const data = await apiFetch<{ user?: SessionUser } | null>("/api/auth/get-session");
  return data?.user ?? null;
}

/** React Query hook for the current user. */
export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: getSessionUser,
    staleTime: 30_000,
  });
}
