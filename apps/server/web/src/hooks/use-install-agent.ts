import { ApiError, NetworkError, NODE_QUERY_KEY, parseErrorBody } from "@internal/node-admin";
import { parseNodeHarnessUpdateResult } from "@internal/subshell-protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HARNESS_QUERY_KEY } from "@/hooks/use-harnesses";
import type { HarnessInfo } from "@/types/harness";

/**
 * The `done` frame both install routes end with.
 *
 * The control-plane route (`POST /api/setup/agents/:id/install`) re-probes the
 * harness after the run and carries its detection row; the enrolled-node route
 * (`POST /api/nodes/:nodeId/harnesses/:id/install`) reports the run alone — no
 * row, no `timedOut` gap filled in client-side, because the card refreshes the
 * node view instead of reading a harness back.
 */
export interface AgentInstallResult {
  /** Whether the installer command itself exited zero */
  ok: boolean;
  /** The installer's exit code, or null when it could not be run */
  exitCode: number | null;
  /** Captured stdout+stderr from the installer */
  output: string;
  /** The harness's detection row after a control-plane install; absent for a remote run */
  harness?: HarnessInfo;
  /** True when the run's own deadline ended it — a remote answer only */
  timedOut?: boolean;
}

/**
 * One NDJSON frame from an install-style stream (the agent installer, the
 * tmux installer, and a harness update).
 *
 * `line` arrives while the command runs, `waiting` is the heartbeat that keeps
 * a silent ten-minute update from reading as an idle connection, and exactly
 * one `done` or `error` ends it. A stream that ends with NEITHER is a failure
 * too — see below.
 */
type InstallFrame<TDone> =
  | { type: "line"; text: string }
  | { type: "waiting" }
  | ({ type: "done" } & TDone)
  | { type: "error"; message: string };

/**
 * Runs a built-in agent's installer on {@link nodeId}'s machine (admin on the
 * control-plane host; owner or manage grantee on an enrolled node),
 * reporting the installer's own output as it arrives; refetches detection
 * afterwards.
 *
 * **Read with `fetch`, not `EventSource`.** Both routes stream NDJSON from
 * the ordinary POST, so the HttpOnly cookie goes with it and the route's own
 * gate is the one that was already there. An `EventSource` cannot send that
 * cookie, which is why the live socket mints a ws-token first — a second
 * authenticated way in, on a surface whose whole job is running a remote
 * script as the server's or the node's user. Not worth it for a progress
 * line.
 *
 * @param onLine - Called with each `line` frame's text as it arrives. A
 *   remote run prints nothing (its output arrives in the `done` frame), so
 *   this only fires for the control-plane installer.
 * @param nodeId - The enrolled node whose CLI to install; absent means the
 *   control-plane host, which is the first-run wizard's path.
 */
export function useInstallAgent(onLine?: (id: string, line: string) => void, nodeId?: string) {
  const queryClient = useQueryClient();
  const remote = nodeId !== undefined;
  return useMutation({
    mutationFn: async (id: string): Promise<AgentInstallResult> => {
      // Same protocol, different machine: a remote install travels the signed
      // `harness_install` command, so the package manager and PATH are the
      // node's. The control-plane host still runs its installer in-process.
      const path = remote
        ? `/api/nodes/${encodeURIComponent(nodeId)}/harnesses/${encodeURIComponent(id)}/install`
        : `/api/setup/agents/${encodeURIComponent(id)}/install`;
      let res: Response;
      try {
        res = await fetch(path, {
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
      return await readInstallStream<AgentInstallResult>(
        res.body,
        (line) => onLine?.(id, line),
        INSTALL_STALL_MS,
        remote ? { malformed: "The server's install result was unreadable." } : {},
        remote
          ? (frame) => {
              const parsed = parseNodeHarnessUpdateResult(frame);
              return parsed === null
                ? null
                : { ok: parsed.ok, exitCode: parsed.exitCode, output: parsed.output, timedOut: parsed.timedOut };
            }
          : undefined,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: HARNESS_QUERY_KEY });
      // The node view carries the remote run's new detection row, so refresh
      // it too — the card reads its rows from there, not from the `done` frame.
      if (nodeId !== undefined) void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, nodeId] });
    },
  });
}

/**
 * How long the page waits with NOTHING arriving before it stops believing the
 * stream.
 *
 * The server bounds the installer itself at ten minutes and then always sends
 * a terminal frame, so total silence for two is not a slow install — it is a
 * stream that is never going to say anything again. Measured on 2026-09-14: a
 * hermes install finished and put its binaries on disk, the server closed its
 * side, and the page span forever because the dev proxy between them never
 * passed the close along. Anything that can stall a body does this — a tunnel,
 * a sleeping laptop, a proxy — and an unbounded read turns it into a spinner
 * with no way out.
 *
 * Generous on purpose: a false trip costs nothing, because giving up here does
 * NOT stop the installer (the route keeps running it on a closed stream, by
 * design) and detection resumes polling the moment the mutation settles — so a
 * install that really was just quiet still flips its row to Detected.
 */
export const INSTALL_STALL_MS = 120_000;

/**
 * What the page says when it gives up on the stream. It promises nothing about
 * the installer, because giving up here does not stop it — the row's own
 * detection is what will answer.
 */
export const STALLED_MESSAGE =
  "The installer stopped reporting. It may still be running; this page will say so once it finishes.";

/**
 * Reads the install route's NDJSON stream to its terminal frame.
 *
 * Exported for its own tests: the three endings that matter are a clean
 * `done`, a body that stops mid-flight, and a body that simply never speaks
 * again, and the last one is the defect this function exists to bound.
 * The `done` frame's PAYLOAD is the type parameter, because two routes stream
 * this same protocol and end it with different facts — the agent installer
 * with a re-probed harness row, the tmux installer with a re-probed binary
 * path. Everything this function actually decides (the frame protocol, the
 * stall bound, the ended-without-saying failure) is the same for both, and a
 * second copy of it would be a second place for those to drift.
 *
 * @param body - The response body to read
 * @param onLine - Called with each `line` frame's text as it arrives
 * @param stallMs - Silence allowed before giving up
 * @param messages - The failure wording for the surfaces that share this
 *   protocol; install is the default because it was the first
 * @param validateDone - Narrows the `done` payload; null throws instead of
 *   handing a malformed result to the page
 */
export async function readInstallStream<TDone = AgentInstallResult>(
  body: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
  stallMs: number = INSTALL_STALL_MS,
  messages: { stalled?: string; ended?: string; malformed?: string } = {},
  validateDone?: (frame: unknown) => TDone | null,
): Promise<TDone> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let done: TDone | undefined;
  const handle = (frame: InstallFrame<TDone>) => {
    if (frame.type === "line") onLine?.(frame.text);
    else if (frame.type === "done") {
      const parsed = validateDone ? validateDone(frame) : frame;
      if (parsed === null) {
        throw new ApiError(502, messages.malformed ?? "The server sent an unreadable result.");
      }
      done = parsed;
    } else if (frame.type === "error") throw new ApiError(500, frame.message);
    // `waiting` is a heartbeat: it exists to keep the connection alive, and
    // has nothing to report.
  };
  try {
    for (;;) {
      // The clock is per READ, so it measures silence rather than duration: a
      // long install that keeps printing never trips it. The timer is CLEARED
      // on every frame — an uncleared one per line would leave a chatty
      // install holding hundreds of pending rejections, each firing minutes
      // later into a race nobody is listening to any more.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ApiError(504, messages.stalled ?? STALLED_MESSAGE)), stallMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") handle(JSON.parse(line) as InstallFrame<TDone>);
    }
    if (pending.trim() !== "") handle(JSON.parse(pending) as InstallFrame<TDone>);
  } finally {
    // Let go of the body either way. On the stall path this is what releases
    // the connection the page has given up on.
    reader.cancel().catch(() => {});
  }
  // A stream that ended with no terminal frame is a failure, not a success
  // with missing fields: the server died, or something between here and it cut
  // the body. Silently resolving would report an install that never finished
  // as one that worked.
  if (!done) throw new ApiError(500, messages.ended ?? "The install ended without saying whether it worked.");
  return done;
}
