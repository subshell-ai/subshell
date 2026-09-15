import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ADMIN_STATUS_QUERY_KEY, type AdminStatus } from "@/hooks/use-admin-status";
import { isNewBoot } from "@/hooks/use-server-restart";
import { apiFetch, errMessage } from "@/lib/api";
import { SERVER_DEPLOYMENT_QUERY_KEY, UPDATES_QUERY_KEY } from "@/lib/query-keys";
import type { ServerUpdateView, UpdatesView } from "@/types/updates";

/**
 * What the Updates page reads (`GET /api/admin/updates`), admin-only.
 *
 * ONE query for three cards: the server's own view, the fleet and the two
 * desktop releases all come out of the SAME release index on the server, so
 * three queries would read it three times and leave the cards disagreeing
 * about which list they saw.
 *
 * `enabled` is the CONFIRMED admin flag rather than a default of true — the
 * gate `/settings/status` established, so a non-admin mount fires no doomed 403.
 *
 * **It does not poll by default.** The release index has a 15-minute TTL on the
 * server and nothing here moves without a press, so a background poll would
 * spend a request per minute to render a number that cannot have changed. What
 * DOES move is a running job, and `useStartServerUpdate` raises the cadence to
 * 1 s for exactly as long as one runs.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 * @param refetchMs - poll cadence; `false` (the default) is no poll at all
 */
export function useUpdates(enabled: boolean, refetchMs: number | false = false) {
  return useQuery({
    queryKey: UPDATES_QUERY_KEY,
    queryFn: () => apiFetch<UpdatesView>("/api/admin/updates"),
    enabled,
    refetchInterval: refetchMs,
    // Mounting the page IS the check: the server's own memo is what keeps that
    // from being a network read every time.
    staleTime: 0,
  });
}

/** What {@link useCheckUpdates} hands the page's Re-check button. */
export interface CheckUpdates {
  /** Re-read the release source now, bypassing the server's 15-minute memo. */
  check(): void;
  /** True while the check is in flight. */
  pending: boolean;
  /** Why the last check failed, null when it did not. */
  error: string | null;
}

/**
 * `POST /api/admin/server/update/check` — the Re-check button.
 *
 * It answers the SERVER half only, so the whole page is invalidated afterwards
 * rather than having that half written into the cache: the node and desktop
 * sections come from the same refreshed index, and a cache write would leave
 * them stating what the previous read said while the server card moved.
 */
export function useCheckUpdates(): CheckUpdates {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => apiFetch<ServerUpdateView>("/api/admin/server/update/check", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UPDATES_QUERY_KEY });
    },
  });
  return {
    check: () => mutation.mutate(),
    pending: mutation.isPending,
    error: mutation.error ? errMessage(mutation.error, "Could not check for updates.") : null,
  };
}

/** Where a pressed update stands, as the Server card renders it. */
export type ServerUpdateOutcome = "idle" | "running" | "waiting" | "done" | "failed" | "timeout";

/** What {@link useStartServerUpdate} hands the Server card. */
export interface StartServerUpdate {
  /** Where the update stands. */
  outcome: ServerUpdateOutcome;
  /** Why the REQUEST itself failed (a 409, say), null when it did not. */
  error: string | null;
  /** The version being installed, once a press has been accepted. */
  installing: string | null;
  /** Ask the server to update itself; `force` overrides the pane-safety refusal. */
  start(opts: { force?: boolean }): Promise<void>;
}

/** How long to wait for the updated server to come back before saying it has not. */
const RESTART_TIMEOUT_MS = 180_000;
const RESTART_POLL_MS = 2_000;

/**
 * Press, 202, watch the job, then wait for the new server to come back.
 *
 * Three phases, because an update is three different waits wearing one button:
 *
 * 1. **`running`** — the job is downloading, verifying, backing up and
 *    swapping, all of it visible through the polled view's `job`. The page
 *    raises `useUpdates`' cadence to 1 s while this lasts.
 * 2. **`waiting`** — the server has exited. Nothing answers, so this polls
 *    `GET /api/admin/status` DIRECTLY, exactly as `useServerRestart` does and
 *    for the same reason: the query cache's unbounded retry belongs to the
 *    offline banner, and a second consumer would fight it for ownership of the
 *    same failure. The budget is three minutes rather than the restart's one —
 *    the new binary runs MIGRATIONS before it listens.
 * 3. **`done` or `failed`** — decided by re-reading the updates view once the
 *    server answers. The swap succeeding is not the update succeeding: the new
 *    binary either completes the transaction or REVERTS it at boot, and
 *    `lastFailure` is the only place that answer exists. So a server that comes
 *    back on the OLD version with a fresh failure is reported as a failure,
 *    which is the case a naive "it answered, therefore it worked" gets exactly
 *    backwards.
 *
 * The waiter stops on unmount, so navigating away mid-update leaves no loop
 * running against a server that may never answer.
 */
export function useStartServerUpdate(): StartServerUpdate {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<ServerUpdateOutcome>("idle");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  /** Poll the job through the page's own read until it stops running. */
  async function watchJob(): Promise<boolean> {
    for (;;) {
      if (cancelled.current) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (cancelled.current) return false;
      let view: UpdatesView;
      try {
        view = await apiFetch<UpdatesView>("/api/admin/updates");
      } catch {
        // The server exiting mid-poll is the SUCCESS path of the swapping
        // phase — it is what `restarting` becomes — so an unreachable server
        // here means "go and wait for it", not "the job failed".
        return true;
      }
      queryClient.setQueryData(UPDATES_QUERY_KEY, view);
      const job = view.server.job;
      if (job === null) return true;
      if (job.phase === "failed") {
        setError(job.error);
        setOutcome("failed");
        return false;
      }
      if (job.phase === "restarting") return true;
    }
  }

  /** Wait for a DIFFERENT boot, then decide from `lastFailure` whether it took. */
  async function waitForNewServer(before: string | undefined, to: string): Promise<void> {
    const began = Date.now();
    for (;;) {
      if (cancelled.current) return;
      try {
        const status = await apiFetch<AdminStatus>("/api/admin/status");
        if (isNewBoot(before, status.runtime.bootedAt)) {
          if (cancelled.current) return;
          queryClient.setQueryData(ADMIN_STATUS_QUERY_KEY, status);
          void queryClient.invalidateQueries({ queryKey: SERVER_DEPLOYMENT_QUERY_KEY });
          const view = await apiFetch<UpdatesView>("/api/admin/updates").catch(() => null);
          if (cancelled.current) return;
          if (view !== null) queryClient.setQueryData(UPDATES_QUERY_KEY, view);
          // The boot either finished the transaction or reverted it. A
          // matching `lastFailure` is the revert, and it is the whole reason
          // this cannot stop at "the server answered".
          const failure = view?.server.lastFailure ?? null;
          if (failure !== null && failure.to === to) {
            setError(failure.error);
            setOutcome("failed");
            return;
          }
          setOutcome("done");
          return;
        }
      } catch {
        // Down, or migrating: both are the expected shape of this wait.
      }
      if (Date.now() - began > RESTART_TIMEOUT_MS) {
        if (!cancelled.current) setOutcome("timeout");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
    }
  }

  return {
    outcome,
    error,
    installing,
    async start(body: { force?: boolean }): Promise<void> {
      setError(null);
      cancelled.current = false;
      // Read the baseline BEFORE the press: once the process is gone there is
      // nothing to ask, and the cached value is the last thing this page saw.
      const before = queryClient.getQueryData<AdminStatus>(ADMIN_STATUS_QUERY_KEY)?.runtime.bootedAt;
      let accepted: { from: string; to: string };
      try {
        accepted = await apiFetch<{ started: true; from: string; to: string }>("/api/admin/server/update", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } catch (err) {
        setError(errMessage(err, "The update could not be started"));
        setOutcome("failed");
        return;
      }
      setInstalling(accepted.to);
      setOutcome("running");
      if (!(await watchJob())) return;
      if (cancelled.current) return;
      setOutcome("waiting");
      await waitForNewServer(before, accepted.to);
    },
  };
}
