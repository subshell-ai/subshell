import { ApiError, NetworkError, NODE_QUERY_KEY, parseErrorBody } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HARNESS_QUERY_KEY } from "@/hooks/use-harnesses";
import { INSTALL_STALL_MS, readInstallStream } from "@/hooks/use-install-agent";

/** What `POST /api/nodes/:id/harnesses/:pluginId/update` answers in its `done` frame. */
export interface HarnessUpdateResult {
  /** Harness plugin id that was updated */
  harnessId: string;
  /** True when the update command exited zero inside its deadline */
  ok: boolean;
  /** Exit code, or null when it was signalled or never started */
  exitCode: number | null;
  /** Combined output of the update command */
  output: string;
  /** Wall-clock duration of the run */
  durationMs: number;
  /** True when the deadline ended the run */
  timedOut: boolean;
}

/**
 * Runs one harness CLI's own update line on the node that holds it.
 *
 * The route streams NDJSON so a silent ten-minute update cannot look like an
 * idle connection: local output arrives as `line` frames, remote runs send
 * heartbeats, and one `done` frame carries the result. Read with `fetch`
 * rather than `EventSource` for the same reason the installer is — the
 * HttpOnly cookie has to travel.
 *
 * "Update all" is the caller looping this sequentially, so two package
 * managers never race over one filesystem. Refetches both reads that can
 * carry the new version: the node view (its harness rows) and the registry.
 */
export function useUpdateHarness(nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (harnessId: string): Promise<HarnessUpdateResult> => {
      let res: Response;
      try {
        res = await fetch(
          `/api/nodes/${encodeURIComponent(nodeId)}/harnesses/${encodeURIComponent(harnessId)}/update`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
          },
        );
      } catch (err) {
        throw new NetworkError(err);
      }
      // Refusals are decided before the body opens, so they are still a status
      // code with a JSON body — the same shape `apiFetch` would have thrown.
      if (!res.ok) {
        const { message, code, errId } = parseErrorBody(await res.text().catch(() => ""));
        throw new ApiError(res.status, message, { code, errId });
      }
      if (!res.body) throw new ApiError(res.status, "The server sent no update output.");
      return await readInstallStream<HarnessUpdateResult>(res.body, undefined, INSTALL_STALL_MS, {
        stalled: "The update stopped reporting. It may still be running; reload to see the harness version.",
        ended: "The update ended without saying whether it worked.",
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, nodeId] });
      void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY });
    },
  });
}
