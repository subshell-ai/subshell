import { apiFetch, apiPost } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ADMIN_STATUS_QUERY_KEY } from "@/hooks/use-admin-status";
import { desktopInvokeStrict } from "@/lib/desktop";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
import { currentMode, type SupervisionMode } from "@/lib/supervision";
import type { ServerDeployment } from "@/types/server-deployment";

/** What the desktop app answers: the CLI's own words, plus where it ended. */
interface SupervisionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * The mode the machine is in NOW, re-read by Rust after the chain.
   *
   * Not an echo of the request. This page derives "current" from the server's
   * report of its own parentage; Rust derives it from its settings file
   * corrected by a definition probe. A stale plist under an app-run server is
   * enough to make the two disagree, and then the request lands on a
   * same-mode branch and nothing happens.
   */
  mode: SupervisionMode;
  /** True when the machine was already there, so nothing ran */
  noop: boolean;
}

/** What {@link useSetSupervision} hands the supervision card. */
export interface SetSupervision {
  /** Move the machine to `mode`; `autostart` is read only when `mode` is `service`. */
  set(mode: SupervisionMode, autostart: boolean, force: boolean): Promise<boolean>;
  /** True while the desktop command itself is running */
  pending: boolean;
  /**
   * The mode being waited FOR, once the command has returned and the server is
   * coming back — null when nothing is in flight.
   */
  settling: SupervisionMode | null;
  /** True when that wait gave up */
  timedOut: boolean;
  /** Why the last attempt failed, null when it did not */
  error: string | null;
  /** The whole chain log behind that failure, null when there is none */
  details: string | null;
  /** Forget the last failure — called when a new dialog opens. */
  reset(): void;
}

/**
 * The last line the CLI said, which is where it explains itself.
 *
 * `ok: false` carries the chain's whole log in `stdout` and the refusal in
 * `stderr`; a dialog has room for one sentence, and the last one is the
 * refusal. The log itself is kept — see `details` — because this chain's
 * failures are PARTIAL: an App→Service run that fails at the install step has
 * already stopped the server the app was running, and one stderr line about
 * the install says nothing about the machine now having no server at all.
 */
function lastLine(result: SupervisionResult): string {
  const last = (text: string) => text.trim().split("\n").at(-1)?.trim();
  return last(result.stderr) || last(result.stdout) || "The switch stopped without saying why.";
}

/** How often the settle wait asks, and how long before it gives up. */
const SETTLE_POLL_MS = 1_000;
const SETTLE_TIMEOUT_MS = 60_000;

/**
 * `desktop_set_supervision`, from the dashboard.
 *
 * A Tauri command, not an HTTP route, and that is not incidental: both
 * directions leave the server unreachable for a moment — an uninstall stops
 * it, a switch back stops the app's child — so nothing the server serves can
 * be the thing that performs it. The desktop app is what outlives the server,
 * and this page reaches it over the webview's IPC, which survives the
 * server going away.
 *
 * **The command returning is NOT the switch being done**, and conflating the
 * two is what made this feel broken. It returns once the new server is
 * STARTING; the page then has to wait for that server to answer before the
 * card can honestly move, and the card reflects the machine rather than the
 * press. So there is a second phase — `settling` — which polls the deployment
 * route directly until it reports the mode that was asked for, exactly as
 * `useServerRestart` waits for a new boot. Without it the dialog closed onto a
 * card still showing the old mode, with nothing on screen saying why.
 *
 * The wait polls DIRECTLY rather than through the query cache, for the same
 * reason the restart waiter does: the cache's unbounded network retry belongs
 * to the offline banner, and a second consumer would fight it for ownership of
 * the same failure. Here the failures are expected and silent.
 */
export function useSetSupervision(): SetSupervision {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [settling, setSettling] = useState<SupervisionMode | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  // Set on unmount, so navigating away mid-switch leaves no loop running
  // against a server that may never answer.
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );

  /** Poll the deployment route until the machine reports `target`. */
  const waitForMode = useCallback(
    async (target: SupervisionMode): Promise<void> => {
      const began = Date.now();
      for (;;) {
        if (gone.current) return;
        try {
          const view = await apiFetch<ServerDeployment>("/api/admin/server");
          if (currentMode(view) === target) {
            if (gone.current) return;
            // Written, not just invalidated: this answer IS the fresh view, and
            // invalidating alone would leave the card on the old mode for one
            // more round trip — the exact gap this wait exists to close.
            queryClient.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view);
            void queryClient.invalidateQueries({ queryKey: ADMIN_STATUS_QUERY_KEY });
            setSettling(null);
            return;
          }
        } catch {
          // Down, or coming back up: both are the expected shape of this wait.
        }
        if (Date.now() - began > SETTLE_TIMEOUT_MS) {
          if (!gone.current) {
            setSettling(null);
            setTimedOut(true);
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
    },
    [queryClient],
  );

  const set = useCallback(
    async (mode: SupervisionMode, autostart: boolean, force: boolean): Promise<boolean> => {
      setPending(true);
      setError(null);
      setDetails(null);
      setTimedOut(false);
      // BEFORE the invoke, and its failure is swallowed: this records the act
      // in the instance's audit trail, and the server is about to go away.
      // `server.autostart.update` wrote a row for the SMALLER change while
      // this one — which removes a service definition — wrote none.
      //
      // It records HONEST use and nothing more. Anything calling the Tauri
      // command directly skips it, an XSS in this page included, which is the
      // threat `docs/security.md` accounts for. A failure here must never stop
      // the switch: a missing audit row is not a reason to refuse the act.
      try {
        await apiPost("/api/admin/server/supervision", { mode, autostart, force });
      } catch {
        // No server, no session, no trail. The act still belongs to the person.
      }
      try {
        const result = await desktopInvokeStrict<SupervisionResult>("desktop_set_supervision", {
          mode,
          autostart,
          force,
        });
        if (!result.ok) {
          setError(lastLine(result));
          // Every step the chain DID complete, in its own words. The steps
          // are destructive in order, so this is the only record of how far
          // the machine moved before it stopped.
          setDetails(
            [result.stdout, result.stderr]
              .map((t) => t.trim())
              .filter(Boolean)
              .join("\n") || null,
          );
          return false;
        }
        if (result.noop && result.mode !== mode) {
          // Success that moved nothing, on a machine that is not where this
          // page thought it was. Reported as a failure because the person's
          // question — "make it run the other way" — was answered No; folding
          // it into `ok` closed the dialog on a radio that never moved, and
          // the whole report was silence.
          setError(
            `This machine is already running the server ${result.mode === "app" ? "with the app" : "in the background"}, so nothing changed. The page was showing the other mode; it will catch up on the next refresh.`,
          );
          void queryClient.invalidateQueries({ queryKey: SERVER_DEPLOYMENT_QUERY_KEY });
          return false;
        }
        // A no-op that landed where it was asked to needs no wait.
        if (result.noop) {
          void queryClient.invalidateQueries({ queryKey: SERVER_DEPLOYMENT_QUERY_KEY });
          return true;
        }
        // The command is done; the SERVER is not. Hand the dialog its success
        // so it can close, and keep waiting on the card.
        setSettling(mode);
        void waitForMode(mode);
        return true;
      } catch (err) {
        // A refusal before anything was touched arrives as the command's
        // `Err(String)`, which Tauri rejects with directly.
        setError(typeof err === "string" ? err : err instanceof Error ? err.message : "Could not switch.");
        return false;
      } finally {
        setPending(false);
      }
    },
    [queryClient, waitForMode],
  );

  // Without this the failure from an "app" attempt greets the next "service"
  // dialog, describing something the person is no longer doing.
  const reset = useCallback(() => {
    setError(null);
    setDetails(null);
    setTimedOut(false);
  }, []);
  return { set, pending, settling, timedOut, error, details, reset };
}
