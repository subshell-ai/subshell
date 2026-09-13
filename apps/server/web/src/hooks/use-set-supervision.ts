import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { SupervisionMode } from "@/components/service/supervision-card";
import { ADMIN_STATUS_QUERY_KEY } from "@/hooks/use-admin-status";
import { desktopInvokeStrict } from "@/lib/desktop";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";

/** What the desktop app answers: the CLI's own words, verbatim. */
interface ActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** What {@link useSetSupervision} hands the supervision card. */
export interface SetSupervision {
  /** Move the machine to `mode`; `autostart` is read only when `mode` is `service`. */
  set(mode: SupervisionMode, autostart: boolean): Promise<boolean>;
  /** True while the chain is running */
  pending: boolean;
  /** Why the last attempt failed, null when it did not */
  error: string | null;
}

/**
 * The last line the CLI said, which is where it explains itself.
 *
 * `ok: false` carries the chain's whole log in `stdout` and the refusal in
 * `stderr`; a dialog has room for one sentence, and the last one is the
 * refusal.
 */
function lastLine(result: ActionResult): string {
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
 * answer here is an `ActionResult`, not a view, and the server that would
 * produce a view has just been replaced.
 */
export function useSetSupervision(): SetSupervision {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback(
    async (mode: SupervisionMode, autostart: boolean): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const result = await desktopInvokeStrict<ActionResult>("desktop_set_supervision", { mode, autostart });
        if (!result.ok) {
          setError(lastLine(result));
          return false;
        }
        await queryClient.invalidateQueries({ queryKey: SERVER_DEPLOYMENT_QUERY_KEY });
        await queryClient.invalidateQueries({ queryKey: ADMIN_STATUS_QUERY_KEY });
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

  return { set, pending, error };
}
