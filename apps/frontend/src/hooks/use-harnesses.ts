import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNode } from "@/hooks/use-nodes";
import { PROFILES_QUERY_KEY } from "@/hooks/use-profiles";
import { ApiError, apiFetch } from "@/lib/api";
import { NODE_QUERY_KEY } from "@/lib/query-keys";
import type { HarnessInfo } from "@/types/harness";
import type { Node, NodeHarness } from "@/types/node";

/** Shared key: the wizard, the profile editor and the per-node card agree. */
export const HARNESS_QUERY_KEY = ["harnesses"];

/**
 * The harness registry. The backend probes detection on every request, so a
 * re-check after installing a CLI is simply a refetch.
 */
export function useHarnesses() {
  return useQuery({
    queryKey: HARNESS_QUERY_KEY,
    queryFn: () => apiFetch<HarnessInfo[]>("/api/setup/harnesses"),
  });
}

/** Fresh detection without leaving the page (the "Re-check" button). */
export function useRecheckHarnesses() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY });
}

/**
 * Flips a harness's enabled state. Turning one on makes the server re-run
 * detection and 409 if the binary is missing — the toggle is the check.
 */
export function useSetHarnessEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<HarnessInfo>(`/api/setup/harnesses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY });
      // Enabling a harness has an invisible second effect server-side: it
      // seeds a Default profile for every user. Without this the profile
      // list/picker holds pre-enable data for the whole staleTime window,
      // making the auto-seeded profile look like it was never created.
      void queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
    },
  });
}

/** Turns an apiFetch failure into the message a harness card should show. */
export function harnessToggleErrorMessage(err: unknown): string {
  // The HTTP status, not its string rendering: ApiError carries it as a
  // number (lib/api.ts), so this survives message/format changes.
  if (err instanceof ApiError && err.status === 409)
    return "Not installed on this machine yet — install it, then re-check.";
  return "Could not change the harness state.";
}

/**
 * The harness rows of ONE node (spec 2026-08-31 §6.2/§9). No second endpoint
 * exists — the rows ride the node view (`GET /api/nodes/:id`), so this is a
 * typed read of that query, not a new fetch; the detail page and the harness
 * card share one cache entry.
 * @param nodeId - The node whose harness states to read
 */
export function useNodeHarnesses(nodeId: string) {
  const query = useNode(nodeId);
  return { ...query, harnesses: (query.data?.harnesses ?? []) as NodeHarness[] };
}

/**
 * Flips a harness on/off for ONE node (`PATCH /api/nodes/:id/harnesses/:harnessId`).
 * The route answers with the caller's full fresh NodeView, so the cache adopts
 * it directly (setQueryData) instead of round-tripping a refetch; the list
 * still invalidates because harness chips render there too. Enabling on an
 * agent whose FRESH inventory reports the binary absent 409s — see
 * {@link nodeHarnessErrorMessage}.
 */
export function useSetNodeHarnessEnabled(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ harnessId, enabled }: { harnessId: string; enabled: boolean }) =>
      apiFetch<Node>(`/api/nodes/${nodeId}/harnesses/${harnessId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (view) => {
      queryClient.setQueryData([...NODE_QUERY_KEY, nodeId], view);
      void queryClient.invalidateQueries({ queryKey: NODE_QUERY_KEY });
    },
  });
}

/**
 * Message for a failed per-node toggle: the server's own 409 copy ("X is not
 * installed on Y" — node-specific wording the local-card constant cannot
 * carry), minus the `API <status>: ` prefix ApiError prepends.
 */
export function nodeHarnessErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return err.message.replace(/^API \d+: /, "");
  return "Could not change the harness state.";
}
