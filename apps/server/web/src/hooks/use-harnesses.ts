import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNode } from "@/hooks/use-nodes";
import { PROFILES_QUERY_KEY } from "@/hooks/use-profiles";
import { ApiError, apiFetch } from "@/lib/api";
import type { HarnessInfo } from "@/types/harness";
import type { NodeHarness } from "@/types/node";

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
 * Installs or removes a plugin on the CONTROL-PLANE HOST (spec 2026-09-09 §12).
 *
 * Was an enable toggle, and the difference is not cosmetic: installing no
 * longer re-runs binary detection, so a plugin whose program is missing
 * installs fine and the row reports the missing program separately. The 409
 * the toggle answered with is gone.
 */
export function useSetHarnessInstalled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, installed }: { id: string; installed: boolean }) =>
      installed
        ? apiFetch<HarnessInfo>(`/api/setup/plugins`, {
            method: "POST",
            body: JSON.stringify({ pluginId: id }),
          })
        : apiFetch<HarnessInfo>(`/api/setup/plugins/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY });
      // Installing a plugin has an invisible second effect server-side: it
      // seeds a Default profile for every user. Without this the profile
      // list/picker holds pre-install data for the whole staleTime window,
      // making the auto-seeded profile look like it was never created.
      void queryClient.invalidateQueries({ queryKey: PROFILES_QUERY_KEY });
    },
  });
}

/** Turns an apiFetch failure into the message a harness card should show. */
export function harnessInstallErrorMessage(err: unknown): string {
  // The HTTP status, not its string rendering: ApiError carries it as a
  // number (lib/api.ts), so this survives message/format changes.
  if (err instanceof ApiError && err.status === 400) return "This build does not carry that plugin.";
  if (err instanceof ApiError && err.status === 403) return "Only an admin can change what this host has installed.";
  return "Could not change what this host has installed.";
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

// `useSetNodePlugin` / `nodePluginErrorMessage` are gone with the route they
// POSTed to: plugins moved to the control plane (spec 2026-09-10), so the
// per-node install route no longer exists and `/settings/plugins` owns the
// verbs. The node page's card reports detection only.
