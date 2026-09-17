import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PUBLIC_SETTINGS_QUERY_KEY } from "@/hooks/use-public-settings";
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
 * **What made a five-second cadence affordable is on the SERVER, not here.** A
 * poll is a `collectDeployment()`, which runs `netstat` and the service
 * manager through `Bun.spawnSync` — and Bun is single-threaded, so the cost is
 * not paid by the poller. It is a whole-process stall: every terminal
 * WebSocket frame and every other API request waits for it. Tripling the rate
 * of that (it was 15 s) was only defensible once `GET /api/admin/server`
 * memoized the collection for ~2 s, so N open tabs cost ONE probe per window
 * instead of N. Do not raise the rate past that window without moving it too.
 *
 * It stays `enabled`-gated to admins, and it has THREE consumers, which want
 * different cadences over the same data:
 *
 * - `/settings/service` takes the 5 s default. It renders the fields that
 *   actually move without a save on that page — the service state,
 *   `logging.debug`, the supervision answer — and it is the page an operator
 *   watches WHILE changing the machine from somewhere else, where a slower
 *   cadence reads as a page that is not updating at all. The Refresh button
 *   that used to paper over that is gone.
 * - `/settings/status` passes 60 s. It renders only `configEnv.path`,
 *   `paths.*`, `service.definitionPath` and the manager log path — every one
 *   of them fixed for the life of the process, per the paragraph above. At
 *   the default it would have tripled the probe load for data that cannot
 *   change while the page is open.
 * - `/settings/networking` passes 60 s with the Addresses card's move
 *   (2026-09-17). It renders the moving fields too — `restartRequired`,
 *   `settings.saved`/`running` — but every one of those changes HERE by a
 *   save that writes the fresh view into this cache itself, so the poll only
 *   catches up with an edit made over ssh, and 60 s is honest for that.
 *
 * The two genuinely poll at different rates on one shared query key:
 * TanStack Query keeps `refetchInterval` per OBSERVER, so each mount runs its
 * own timer and the faster one does not drag the slower along.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 * @param refetchMs - poll cadence in milliseconds; also the `staleTime`, so
 *   the "matched to the interval" invariant below holds for every caller
 */
export function useServerDeployment(enabled: boolean, refetchMs = 5_000) {
  return useQuery({
    queryKey: SERVER_DEPLOYMENT_QUERY_KEY,
    queryFn: () => apiFetch<ServerDeployment>("/api/admin/server"),
    enabled,
    refetchInterval: refetchMs,
    // Matched to the interval: above it, a remount would render a view older
    // than the cadence the page promises.
    staleTime: refetchMs,
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
 *
 * A save also invalidates the public settings, because `TRUSTED_ORIGINS` is
 * part of the effective allowlist they report and the server applies it live.
 */
export function useUpdateServerConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ServerConfigPatch) =>
      apiFetch<ServerConfigUpdate>("/api/admin/server/config", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: ({ warnings: _warnings, ...view }) => {
      queryClient.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view satisfies ServerDeployment);
      // `TRUSTED_ORIGINS` is part of the EFFECTIVE allowlist the public
      // settings report, and the server applies a change to it live — so the
      // mobile dialog's picker and the setup checklist are stale the moment
      // this returns. Invalidated rather than written: this response is the
      // deployment view, not the union the public route computes.
      void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
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
