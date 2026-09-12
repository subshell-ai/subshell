import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
import type { ServerConfigPatch, ServerConfigUpdate, ServerDeployment } from "@/types/server-deployment";

/**
 * How this server is deployed (`GET /api/admin/server`), admin-only.
 *
 * `enabled` is the caller's CONFIRMED admin flag, not a default of true: the
 * route 403s everyone else, so an unknown flag must read as not-admin or every
 * mount fires a doomed request — the same gate `/settings/status` applies.
 *
 * It polls because the view is partly about a live process: the service
 * manager's state and pid, and `restartRequired`, which flips the moment
 * someone edits config.env over ssh. Fifteen seconds is the cadence
 * `admin/status` already runs at, so the Service page costs no new rhythm.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 */
export function useServerDeployment(enabled: boolean) {
  return useQuery({
    queryKey: SERVER_DEPLOYMENT_QUERY_KEY,
    queryFn: () => apiFetch<ServerDeployment>("/api/admin/server"),
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

/**
 * `PATCH /api/admin/server/config` — rewrite the keys the person touched.
 *
 * The answer IS the fresh view, so it is written into the cache directly
 * rather than invalidated: an invalidation would leave the card rendering the
 * pre-write `restartRequired` until a refetch landed, which is the one fact
 * the person just changed and is watching for.
 *
 * `warnings` is stripped on the way into the cache — it describes THIS write,
 * not the deployment, and a later poll would silently drop it anyway.
 */
export function useUpdateServerConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ServerConfigPatch) =>
      apiFetch<ServerConfigUpdate>("/api/admin/server/config", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: ({ warnings: _warnings, ...view }) => {
      queryClient.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view satisfies ServerDeployment);
    },
  });
}
