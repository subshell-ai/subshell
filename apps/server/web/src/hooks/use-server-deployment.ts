import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, errMessage } from "@/lib/api";
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

/** What {@link useSetServerAutostart} hands the Service card. */
export interface ServerAutostart {
  /** Ask the server to arm or disarm start-at-login. */
  set(enabled: boolean): void;
  /** True while a change is in flight. */
  pending: boolean;
  /** Why the last attempt failed, null when it did not. */
  error: string | null;
}

/**
 * `POST /api/admin/server/autostart` — arm or disarm start-at-login.
 *
 * The answer is the fresh view, written straight into the cache for the same
 * reason the config write does it: the fact the person just changed is the
 * one they are watching, and an invalidation would leave the switch showing
 * the old value until a refetch landed.
 *
 * Nothing is written optimistically. This one spawns a service manager, and
 * the refusals are real (nothing installed, the app runs this server, the
 * manager would not say) — a switch that flipped and then flipped back is a
 * worse answer than one that waits.
 */
export function useSetServerAutostart(): ServerAutostart {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<ServerDeployment>("/api/admin/server/autostart", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (view) => {
      queryClient.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view);
    },
  });
  return {
    set: (enabled) => mutation.mutate(enabled),
    pending: mutation.isPending,
    error: mutation.error ? errMessage(mutation.error, "Could not change the login setting.") : null,
  };
}
