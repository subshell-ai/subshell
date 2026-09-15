import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SUBSHELL_QUERY_KEY, SUBSHELL_SHARES_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellAccess } from "@/types/subshell";

/**
 * Sharing reads/writes for one subshell (spec 2026-08-31 §4). The grant shape
 * mirrors the backend `SubshellShareSchema`; `granteeUserId` null is the
 * "Everyone" grant. `useSetShares` PUTs the complete replacement set (the same
 * contract as the backend route).
 */
export interface SubshellShare {
  /** Share row id */
  id: string;
  /** Grantee user id, or null for the Everyone grant */
  granteeUserId: string | null;
  /** Grantee display name ("Everyone" for the null grant) */
  granteeName: string | null;
  /** Access level this grant confers */
  permission: Exclude<SubshellAccess, "owner">;
}

/** A grantee choice for the dialog's add-row: who + how much. */
export type ShareDraft = { granteeUserId: string | null; permission: Exclude<SubshellAccess, "owner"> };

/** GETs a subshell's current grants. Only meaningful for the owner (others 403). */
export function useShares(id: string, enabled = true) {
  return useQuery({
    queryKey: [...SUBSHELL_SHARES_QUERY_KEY, id],
    queryFn: () => apiFetch<{ shares: SubshellShare[] }>(`/api/subshells/${id}/shares`),
    enabled: enabled && id.length > 0,
  });
}

/**
 * PUTs the whole grant set (a grant not present in `shares` is removed). On
 * success the shares query and the subshell detail both refresh (the latter so
 * the caller's own `access`/visibility is re-read).
 */
export function useSetShares(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (shares: ShareDraft[]) =>
      apiFetch<{ shares: SubshellShare[] }>(`/api/subshells/${id}/shares`, {
        method: "PUT",
        body: JSON.stringify({ shares }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...SUBSHELL_SHARES_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: SUBSHELL_QUERY_KEY });
    },
  });
}

/** A user from the instance roster, as returned by the instance-wide `GET /api/users`. */
export interface RosterUser {
  /** better-auth user id */
  id: string;
  /** Display name, asked for at creation (spec 2026-09-14 §1) */
  name: string;
  /**
   * Email address, and the picker's display label — deliberately still the
   * email now that a name exists beside it: two people can share a name and
   * a share is a grant to exactly one account, so the label has to be the
   * identity rather than the friendlier string.
   */
  email: string;
}

/**
 * The roster an owner may share with. `GET /api/users` is instance-wide READ
 * for any signed-in user (only writes are admin-gated), so this needs no extra
 * endpoint — which matters because the composed API type is at Elysia's
 * inference-depth limit and cannot afford a new route module.
 * @param enabled - Gate the fetch (the sharing dialog passes `open` so a closed
 *                  dialog fetches nothing).
 */
export function useSharableUsers(enabled = true) {
  return useQuery({
    queryKey: ["sharable-users"],
    queryFn: async () => (await apiFetch<{ viewerIsAdmin: boolean; users: RosterUser[] }>("/api/users")).users ?? [],
    enabled,
    staleTime: 60_000,
  });
}
