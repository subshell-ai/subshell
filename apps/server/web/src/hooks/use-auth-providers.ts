import { apiFetch, apiPost } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateAuthProviderBody, PatchAuthProviderBody, ProviderAdminView } from "@/types/auth-provider";

/** Query key of the admin provider list. */
export const AUTH_PROVIDERS_QUERY_KEY = ["auth-providers"] as const;

/**
 * The login page's instance read (`["instance-name"]` in `routes/login.tsx`).
 * Task 9 grows that anonymous body with the provider list the login page renders,
 * so every provider write invalidates it: an admin who adds a provider sees the
 * signed-out preview answer with the new provider on the next mount.
 */
export const INSTANCE_NAME_QUERY_KEY = ["instance-name"] as const;

/** Envelope of `GET /api/auth-providers`. */
interface AuthProvidersEnvelope {
  providers: ProviderAdminView[];
}

/**
 * The admin provider list (`GET /api/auth-providers`, cookie-admin only).
 * `enabled` gates it like every other admin surface here: the caller passes
 * the server-derived `viewerIsAdmin === true`, so a member's mount fires no
 * doomed 403.
 */
export function useAuthProviders(enabled: boolean) {
  return useQuery({
    queryKey: AUTH_PROVIDERS_QUERY_KEY,
    queryFn: async () => (await apiFetch<AuthProvidersEnvelope>("/api/auth-providers")).providers,
    enabled,
    retry: false,
  });
}

/**
 * Every successful write lands the list and the login page's preview: the
 * list because it changed, the preview because the anonymous read now names
 * a different set of providers. `PUBLIC_SETTINGS_QUERY_KEY` is deliberately NOT
 * touched — the public settings body is not what these routes change.
 */
function useAuthProvidersInvalidation() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: AUTH_PROVIDERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: INSTANCE_NAME_QUERY_KEY }),
    ]);
}

/** `POST /api/auth-providers`. Failures surface as `ApiError` with the
 * server's structured `code` (SLUG_TAKEN, DISCOVERY_FAILED, …). */
export function useCreateAuthProvider() {
  const invalidate = useAuthProvidersInvalidation();
  return useMutation({
    mutationFn: (body: CreateAuthProviderBody) => apiPost<ProviderAdminView>("/api/auth-providers", body),
    onSuccess: invalidate,
  });
}

/** `PATCH /api/auth-providers/:id` — a partial body; `id`/`kind` are immutable. */
export function usePatchAuthProvider() {
  const queryClient = useQueryClient();
  const invalidate = useAuthProvidersInvalidation();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAuthProviderBody }) =>
      apiFetch<ProviderAdminView>(`/api/auth-providers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      // Apply the server's answer before releasing controls, even if the
      // follow-up list read is slow or fails. All rows share the guard state.
      queryClient.setQueryData<ProviderAdminView[]>(AUTH_PROVIDERS_QUERY_KEY, (previous) =>
        previous?.map((provider) => (provider.id === updated.id ? updated : provider)),
      );
      return invalidate();
    },
  });
}

/** `DELETE /api/auth-providers/:id`. The email row's refusal (EMAIL_ROW_UNDELETABLE) arrives as an `ApiError`. */
export function useDeleteAuthProvider() {
  const invalidate = useAuthProvidersInvalidation();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/auth-providers/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

// The `POST /api/auth-providers/test` probe hook is GONE with its route
// (operator ruling 2026-09-25): the save is the verification, so `create`
// and `patch` above are the only writes and the only checks.
