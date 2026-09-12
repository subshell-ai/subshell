import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ADMIN_STATUS_QUERY_KEY, type AdminStatus } from "@/hooks/use-admin-status";
import { apiFetch, errMessage } from "@/lib/api";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";

/** Where the restart stands: before the press, during the outage, and after it. */
export type RestartOutcome = "idle" | "waiting" | "back" | "timeout";

/**
 * How far apart two `bootedAt` readings may be and still be the SAME boot.
 *
 * `admin/status` derives that field as `now - uptime*1000` from a
 * whole-second uptime, so two reads of one unrestarted process disagree by
 * around a second. Comparing for equality would call the first poll a
 * successful restart; five seconds is comfortably above the drift and
 * comfortably below the gap a real restart leaves (systemd's `RestartSec=5`
 * plus boot).
 */
export const BOOT_DRIFT_MS = 5000;

/**
 * Whether a freshly read `bootedAt` names a DIFFERENT boot from the one held
 * before the press, allowing for the derivation's drift.
 *
 * With no baseline (the status query had never resolved) any answer counts:
 * the server answering at all is the only evidence available, and reporting
 * "back" is the honest reading of it.
 *
 * @param before - the boot time the cache held before the restart was requested
 * @param now - the boot time the server just reported
 */
export function isNewBoot(before: string | undefined, now: string): boolean {
  if (!before) return true;
  const a = Date.parse(before);
  const b = Date.parse(now);
  if (Number.isNaN(a) || Number.isNaN(b)) return before !== now;
  return Math.abs(b - a) > BOOT_DRIFT_MS;
}

/** What {@link useServerRestart} hands its cards. */
export interface ServerRestart {
  /** Where the restart stands */
  outcome: RestartOutcome;
  /** Why the request itself failed, null when it did not */
  error: string | null;
  /** The address the server said it would come back at, null before a press */
  resumeAt: string | null;
  /** Ask the server to restart itself; `force` overrides the pane-safety refusal */
  restart(opts: { force?: boolean }): Promise<void>;
  /** Return to idle and stop waiting */
  reset(): void;
}

/**
 * Press, 202, then wait for the server to come back (spec 2026-09-12 § 4.4).
 *
 * The wait polls `GET /api/admin/status` DIRECTLY rather than through the
 * query cache. The cache's unbounded network retry belongs to the offline
 * banner, which shows "Can't reach the subshell server, retrying…" through
 * exactly this outage; a second consumer of that machinery would fight it for
 * ownership of the same failure. Here the failures are expected and silent,
 * and the only thing being watched for is a boot time that is not the old one.
 *
 * The waiter stops on unmount, so navigating away from the Service page mid
 * restart leaves no loop running against a server that may never answer.
 *
 * @param opts - poll interval and cap; the defaults are the product's
 */
export function useServerRestart(opts: { pollMs?: number; timeoutMs?: number } = {}): ServerRestart {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<RestartOutcome>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resumeAt, setResumeAt] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  async function waitForNewBoot(before: string | undefined): Promise<void> {
    const began = Date.now();
    for (;;) {
      if (cancelled.current) return;
      try {
        const status = await apiFetch<AdminStatus>("/api/admin/status");
        if (isNewBoot(before, status.runtime.bootedAt)) {
          if (cancelled.current) return;
          setOutcome("back");
          void queryClient.invalidateQueries({ queryKey: ADMIN_STATUS_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: SERVER_DEPLOYMENT_QUERY_KEY });
          return;
        }
      } catch {
        // Down, or coming back up: both are the expected shape of this wait.
      }
      if (Date.now() - began > timeoutMs) {
        if (!cancelled.current) setOutcome("timeout");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    outcome,
    error,
    resumeAt,
    async restart(body: { force?: boolean }): Promise<void> {
      setError(null);
      // Read the baseline BEFORE the press: once the process is gone there is
      // nothing to ask, and the cached value is the last thing this page saw.
      const before = queryClient.getQueryData<AdminStatus>(ADMIN_STATUS_QUERY_KEY)?.runtime.bootedAt;
      try {
        const res = await apiFetch<{ restarting: true; resumeAt: string }>("/api/admin/server/restart", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setResumeAt(res.resumeAt);
        setOutcome("waiting");
        cancelled.current = false;
        void waitForNewBoot(before);
      } catch (err) {
        setError(errMessage(err, "The restart could not be requested"));
      }
    },
    reset(): void {
      cancelled.current = true;
      setOutcome("idle");
      setError(null);
    },
  };
}
