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
 * It polls because part of this view moves without the page touching it:
 * `restartRequired` and `settings.saved` flip the moment someone edits
 * config.env over ssh, `installed`/`enabled` flip when someone runs
 * `systemctl --user disable` at a terminal, and `logging.debug` flips when
 * another admin does. Everything ELSE is either fixed for the life of the
 * process (paths, platform, and `pid`/`state`/`supervised`, which can only
 * change by this process dying) or written straight into this cache by the
 * mutation that changed it — so the poll is for out-of-band edits alone.
 *
 * Five seconds because this is the page an operator watches WHILE changing
 * the machine from somewhere else, and a slower cadence reads as a page that
 * is not updating at all. The Refresh button that used to paper over that is
 * gone. It is not free — each poll is a `collectDeployment()`, which probes
 * the port and spawns the service manager — so it stays `enabled`-gated to
 * admins and this is the only consumer.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 */
export function useServerDeployment(enabled: boolean) {
  return useQuery({
    queryKey: SERVER_DEPLOYMENT_QUERY_KEY,
    queryFn: () => apiFetch<ServerDeployment>("/api/admin/server"),
    enabled,
    refetchInterval: 5_000,
    // Matched to the interval: above it, a remount would render a view older
    // than the cadence the page promises.
    staleTime: 5_000,
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
