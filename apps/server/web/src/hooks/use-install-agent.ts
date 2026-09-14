import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HARNESS_QUERY_KEY } from "@/hooks/use-harnesses";
import { ApiError, NetworkError, parseErrorBody } from "@/lib/api";
import type { HarnessInfo } from "@/types/harness";

/** The `done` frame of `POST /api/setup/agents/:id/install`. */
export interface AgentInstallResult {
  /** Whether the installer command itself exited zero */
  ok: boolean;
  /** The installer's exit code, or null when it could not be run */
  exitCode: number | null;
  /** Captured stdout+stderr from the installer */
  output: string;
  /** The harness's detection row after the install attempt */
  harness: HarnessInfo;
}

/**
 * One NDJSON frame from the install stream.
 *
 * `line` arrives while the installer runs; exactly one `done` or `error` ends
 * it. A stream that ends with NEITHER is a failure too — see below.
 */
type InstallFrame =
  | { type: "line"; text: string }
  | ({ type: "done" } & AgentInstallResult)
  | { type: "error"; message: string };

/**
 * Runs a built-in agent's installer on the control-plane host (admin only),
 * reporting the installer's own output as it arrives; refetches detection
 * afterwards.
 *
 * **Read with `fetch`, not `EventSource`.** The route streams NDJSON from the
 * ordinary POST, so the HttpOnly cookie goes with it and the admin gate is the
 * one that was already there. An `EventSource` cannot send that cookie, which
 * is why `live.route.ts` mints a ws-token first — a second authenticated way
 * in, on a surface whose whole job is running a remote script as the server's
 * user. Not worth it for a progress line.
 */
export function useInstallAgent(onLine?: (id: string, line: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<AgentInstallResult> => {
      let res: Response;
      try {
        res = await fetch(`/api/setup/agents/${id}/install`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        throw new NetworkError(err);
      }
      // Refusals are decided before the body opens, so they are still a status
      // code with a JSON body — the same shape `apiFetch` would have thrown.
      if (!res.ok) {
        const { message, code, errId } = parseErrorBody(await res.text().catch(() => ""));
        throw new ApiError(res.status, message, { code, errId });
      }
      if (!res.body) throw new ApiError(res.status, "The server sent no install output.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let done: AgentInstallResult | undefined;
      const handle = (frame: InstallFrame) => {
        if (frame.type === "line") onLine?.(id, frame.text);
        else if (frame.type === "done") done = frame;
        else throw new ApiError(500, frame.message);
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") handle(JSON.parse(line) as InstallFrame);
      }
      if (pending.trim() !== "") handle(JSON.parse(pending) as InstallFrame);
      // A stream that ended with no terminal frame is a failure, not a
      // success with missing fields: the server died, or something between
      // here and it cut the body. Silently resolving would report an install
      // that never finished as one that worked.
      if (!done) throw new ApiError(500, "The install ended without saying whether it worked.");
      return done;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY }),
  });
}
