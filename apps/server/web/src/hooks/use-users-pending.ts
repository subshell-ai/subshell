import { apiFetch } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Query key of the approval queue. */
export const USERS_PENDING_QUERY_KEY = ["users-pending"] as const;

/**
 * Query key of the members roster. This hook owns the definition: the page's
 * fetch in `routes/settings_.users.tsx` imports it from here (the page owns
 * the fetch; this hook only invalidates it), so do not re-inline a duplicate
 * `["users"]` there. An approval turns a queue row into a member, so the
 * accept/reflect edge lands on BOTH lists: the row leaves here and appears
 * there.
 */
export const USERS_QUERY_KEY = ["users"] as const;

/** The queue decision `PATCH /api/users/:id/approval` records. */
export type ApprovalDecision = "approved" | "rejected";

/**
 * One row of `GET /api/users/pending` — a person a door let through who is
 * not a member yet (spec 2026-09-24 §6).
 */
export interface PendingUserRow {
  /** better-auth user id */
  id: string;
  /** The email the door's profile carried */
  email: string;
  /** Display name; empty for a door arrival that carried none */
  name: string;
  /** The door this arrival came through; null for an account with no sign-in row */
  providerId: string | null;
  /** The door's current name, resolved live; null when it has since been removed */
  providerName: string | null;
  /** ISO 8601 stamp of the last knock while pending; null once the row left pending */
  arrivedAt: string | null;
  /** Queue state — approved accounts are members and live in `GET /api/users` */
  approvalState: "pending" | "rejected";
}

/** Envelope of `GET /api/users/pending`. */
interface PendingEnvelope {
  pending: PendingUserRow[];
}

/**
 * The approval queue (`GET /api/users/pending`, cookie-admin only).
 * `enabled` gates it like every other admin surface here: the caller passes
 * the server-derived `viewerIsAdmin === true`, so a member's mount fires no
 * doomed 403.
 */
export function useUsersPending(enabled: boolean) {
  return useQuery({
    queryKey: USERS_PENDING_QUERY_KEY,
    queryFn: async () => (await apiFetch<PendingEnvelope>("/api/users/pending")).pending,
    enabled,
    retry: false,
  });
}

/**
 * `PATCH /api/users/:id/approval` — approve or reject one queue arrival.
 * Both success edges move the row between the two lists, so one invalidation
 * pair covers the accept and the reject alike. The server's refusal on an
 * already-approved target (409 APPROVAL_NOOP) arrives as an `ApiError`, and
 * the row shows its message with the app-wide error prefix, as every other
 * error surface here does.
 */
export function useSetUserApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, approvalState }: { id: string; approvalState: ApprovalDecision }) =>
      apiFetch(`/api/users/${id}/approval`, { method: "PATCH", body: JSON.stringify({ approvalState }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_PENDING_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    },
  });
}
