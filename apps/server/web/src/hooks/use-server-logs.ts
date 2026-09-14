import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SERVER_DEPLOYMENT_QUERY_KEY, SERVER_LOGS_QUERY_KEY } from "@/lib/query-keys";
import type { ServerDeployment, ServerLogs } from "@/types/server-deployment";

/** Lines the Server log card asks for, and the route's own default. */
export const SERVER_LOG_DEFAULT_LINES = 200;

/**
 * The tail of the server's own log file (`GET /api/admin/server/logs`).
 *
 * The file is capped at 200 KB and replaced when full, so this is never a
 * history — it is the recent past, which is what a person looking at a server
 * that just misbehaved needs.
 *
 * **One second, and pausable.** A log is the one thing on this page a person
 * WATCHES rather than checks, and at five seconds a line you just caused
 * arrived long enough after the cause to break the connection between them.
 * The route affords the rate: it reads the tail of a capped file and spawns
 * nothing — unlike `/api/admin/server`, which probes the port and the service
 * manager — and it is in the request logger's own `ignore` list
 * (`api/src/plugins/context.plugin.ts`), so a debug session cannot fill the
 * cap with the log card asking after the log. Keep it on that list.
 *
 * Pausing stops the POLLING rather than freezing a still-running one. The
 * point of pausing is to hold a line still while you read it, and a query
 * that kept fetching would keep re-pinning the scroll underneath you.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 * @param opts - `paused` stops the poll; `lines` is how many to ask for (the route clamps to 1..1000)
 */
/** The tail's cadence. A parameter only so tests can drive it fast — see `NodeLogCard`'s `pollMs`. */
export const SERVER_LOG_POLL_MS = 1_000;

export function useServerLogs(
  enabled: boolean,
  {
    paused = false,
    lines = SERVER_LOG_DEFAULT_LINES,
    pollMs = SERVER_LOG_POLL_MS,
  }: { paused?: boolean; lines?: number; pollMs?: number } = {},
) {
  return useQuery({
    queryKey: [...SERVER_LOGS_QUERY_KEY, lines],
    queryFn: () => apiFetch<ServerLogs>(`/api/admin/server/logs?lines=${lines}`),
    enabled,
    refetchInterval: paused ? false : pollMs,
    // Matched to the interval: above it, a remount would render a tail older
    // than the cadence the card promises.
    staleTime: 1_000,
  });
}

/**
 * `PUT /api/admin/server/logging` — the debug switch.
 *
 * Applied live on the server (the transport's level is flipped, no restart),
 * and the answer is the fresh deployment view, so it is written straight into
 * that query's cache: the switch and the sentence under it both read from the
 * view, and anything less would leave them showing the old state until the
 * next poll.
 *
 * Refused with 409 while `SUBSHELL_DEBUG_LOGGING` is set; the card renders the
 * switch as a sentence in that case rather than relying on the refusal.
 */
export function useSetDebugLogging() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (debug: boolean) =>
      apiFetch<ServerDeployment>("/api/admin/server/logging", { method: "PUT", body: JSON.stringify({ debug }) }),
    onSuccess: (view) => {
      queryClient.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view);
    },
  });
}
