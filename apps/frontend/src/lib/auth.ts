import { useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { CURRENT_USER_QUERY_KEY } from "@/lib/query-keys";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Fetches the current session through the better-auth client.
 * Returns null when unauthenticated (401/403); other failures throw so the
 * query surfaces a real error instead of silently rendering signed-out.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const { data, error } = await authClient.getSession();
  if (error && error.status !== 401 && error.status !== 403) {
    throw new Error(error.message ?? "Session check failed");
  }
  const user = data?.user;
  return user ? { id: user.id, email: user.email, name: user.name ?? "" } : null;
}

/** React Query hook for the current user. */
export function useCurrentUser() {
  return useQuery({
    queryKey: CURRENT_USER_QUERY_KEY,
    queryFn: getSessionUser,
    staleTime: 30_000,
  });
}
