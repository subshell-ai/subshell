import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { SupervisionMode } from "@/components/service/supervision-card";
import { ADMIN_STATUS_QUERY_KEY } from "@/hooks/use-admin-status";
import { apiPost } from "@/lib/api";
import { desktopInvokeStrict } from "@/lib/desktop";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";

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
  /** True while the chain is running */
  pending: boolean;
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

/**
 * `desktop_set_supervision`, from the dashboard.
 *
 * A Tauri command, not an HTTP route, and that is not incidental: both
 * directions leave the server unreachable for a moment — an uninstall stops
 * it, a switch back stops the app's child — so nothing the server serves can
 * be the thing that performs it. The desktop app is what outlives the server,
 * and this page reaches it over the webview's IPC, which survives the
 * server going away. The call returns once the new server is starting.
 *
 * Both admin queries are invalidated on success rather than written: the
 * answer here is a `SupervisionResult`, not a view, and the server that would
 * produce a view has just been replaced.
 */
export function useSetSupervision(): SetSupervision {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);

  const set = useCallback(
    async (mode: SupervisionMode, autostart: boolean, force: boolean): Promise<boolean> => {
      setPending(true);
      setError(null);
      setDetails(null);
      // BEFORE the invoke, and deliberately unawaited-on-failure: this records
      // the act in the instance's audit trail, and the server is about to go
      // away. `server.autostart.update` wrote a row for the SMALLER change
      // while this one — which removes a service definition — wrote none.
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
        // `void`, NOT `await`. `invalidateQueries` resolves only once the
        // refetch settles, and this app retries a `NetworkError` UNBOUNDED
        // (`lib/query-client.ts`) — so during the outage this very switch
        // causes, awaiting it never returns. `pending` then stays true, and
        // the dialog disables its own Cancel and refuses to dismiss: a modal
        // saying "Switching…" forever, on a page whose server is gone, which
        // is the one surface that could have explained what happened.
        //
        // They still refetch, and still recover when the server answers.
        void queryClient.invalidateQueries({ queryKey: SERVER_DEPLOYMENT_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: ADMIN_STATUS_QUERY_KEY });
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
    [queryClient],
  );

  // Without this the failure from an "app" attempt greets the next "service"
  // dialog, describing something the person is no longer doing.
  const reset = useCallback(() => {
    setError(null);
    setDetails(null);
  }, []);
  return { set, pending, error, details, reset };
}
