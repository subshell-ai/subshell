import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ADMIN_STATUS_QUERY_KEY } from "@/hooks/use-admin-status";
import { readInstallStream } from "@/hooks/use-install-agent";
import { ApiError, NetworkError, parseErrorBody } from "@/lib/api";

/** The `done` frame of `POST /api/setup/tmux/install`. */
export interface TmuxInstallResult {
  /** Whether the installer command itself exited zero */
  ok: boolean;
  /** The installer's exit code, or null when it could not be run */
  exitCode: number | null;
  /** Captured stdout+stderr from the installer */
  output: string;
  /** How long the run took, in milliseconds */
  durationMs: number;
  /**
   * Where tmux is NOW, re-probed after the installer exited, or null when it
   * is still not on the server's PATH.
   *
   * Separate from `ok` on purpose: a package manager can exit zero having
   * installed into a directory the server process cannot see, which is exactly
   * what the CLI's own offer re-probes for. The two facts disagree in that
   * case and the row says which happened.
   */
  tmuxPath: string | null;
}

/**
 * Installs tmux on the control-plane host (admin only), reporting the package
 * manager's own output as it arrives.
 *
 * Read with `fetch` rather than `EventSource` for the same reason the agent
 * installer is: the route streams NDJSON from an ordinary POST, so the
 * HttpOnly cookie goes with it and the admin gate is the one that was already
 * there.
 *
 * Settling invalidates the admin status read, which is where the page's tmux
 * detection comes from. The server drops its own memo of that fact at the same
 * moment — without both halves, a host that just gained tmux keeps reporting
 * that it has none.
 *
 * @param onLine - Called with each line the installer prints
 */
export function useInstallTmux(onLine?: (line: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<TmuxInstallResult> => {
      let res: Response;
      try {
        res = await fetch("/api/setup/tmux/install", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        throw new NetworkError(err);
      }
      // Refusals are decided before the body opens — no package manager, a
      // sudo-prefixed one, one already running — so they are still a status
      // code with a JSON body.
      if (!res.ok) {
        const { message, code, errId } = parseErrorBody(await res.text().catch(() => ""));
        throw new ApiError(res.status, message, { code, errId });
      }
      if (!res.body) throw new ApiError(res.status, "The server sent no install output.");
      return await readInstallStream<TmuxInstallResult>(res.body, onLine);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ADMIN_STATUS_QUERY_KEY }),
  });
}
