import { ApiError, apiFetch } from "@internal/node-admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** One admin-managed system API key (never the secret — only its preview). */
export interface SystemKeyRow {
  /** Key id used for enable/disable/delete. */
  id: string;
  /** Human-readable name shown in the list. */
  name: string;
  /** Non-secret start of the key, for identification. */
  preview: string | null;
  /** Whether the key currently authenticates. */
  enabled: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 expiry, null when the key never expires. */
  expiresAt: string | null;
}

/** The create response — the plaintext is delivered exactly once, here. */
export interface CreatedSystemKey {
  /** Key id for later management. */
  id: string;
  /** The plaintext key — shown once, then never again. */
  key: string;
}

/** Shared key so mutations and the card agree on invalidation. */
export const SYSTEM_KEYS_QUERY_KEY = ["system-keys"];

/** All system-wide API keys, newest first (admin-only endpoint). */
export function useSystemKeys() {
  return useQuery({
    queryKey: SYSTEM_KEYS_QUERY_KEY,
    queryFn: () => apiFetch<{ keys: SystemKeyRow[] }>("/api/system-keys"),
  });
}

/** Mints a key; the returned plaintext must be surfaced once by the caller. */
export function useCreateSystemKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<CreatedSystemKey>("/api/system-keys", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SYSTEM_KEYS_QUERY_KEY });
    },
  });
}

/** Flips enabled — disabling revokes the bearer immediately. */
export function useSetSystemKeyEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/system-keys/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SYSTEM_KEYS_QUERY_KEY });
    },
  });
}

/** Removes a key row for good. */
export function useDeleteSystemKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/api/system-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SYSTEM_KEYS_QUERY_KEY });
    },
  });
}

/** Turns an apiFetch failure on a system-key surface into short user copy. */
export function keyErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "Admin sign-in required to manage API keys.";
  return "Something went wrong. The change was not saved.";
}
