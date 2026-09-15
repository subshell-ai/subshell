import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY } from "@/lib/query-keys";

/** What `POST /api/nodes/:id/update` answers on a 202. */
export interface NodeUpdateStarted {
  /** Always true; the agent accepted the command and is restarting into the new binary */
  ok: true;
  /** The agent version that was running on that machine */
  from: string;
  /** The version it installed */
  to: string;
  /**
   * The download URL the node was given, WITHOUT its single-use token.
   *
   * It is echoed for one reason: it is built from this server's own
   * `APP_BASE_URL`, the same base the enroll script bakes, so it carries the
   * same loopback trap. A remote machine told to fetch from `127.0.0.1` dials
   * itself, and the failure is otherwise unexplainable from the page.
   */
  url: string;
}

/**
 * Replace one enrolled node's agent binary and restart it into the new version
 * (spec 2026-09-15 §5.3).
 *
 * **This is the action a HELD node exists for.** An agent the server refuses
 * for its version or its protocol is no longer dropped — its socket is held
 * open for this one command — so `node.held` being non-null is precisely when
 * pressing this is both possible and the only thing that helps. It also works
 * on an ordinary online node that is simply behind.
 *
 * 409s carry the refusal: `NODE_OFFLINE` (nothing connected, held or live),
 * `NODE_UPDATE_UNAVAILABLE` (this server can offer no compatible release, or
 * none for that platform), `NODE_AGENT_TOO_OLD` (the agent predates the
 * `update` command itself — the remedy is `subshell update` at that machine),
 * `NODE_NOT_SUPERVISED`, `NODE_RESTART_KILLS_PANES` (which `{ force: true }`
 * overrides), and `NODE_UPDATE_FAILED` for everything the agent refused after
 * the command arrived — a download that failed, a digest that did not match, a
 * binary that reported the wrong version. On all three of those last ones the
 * node's binary is untouched.
 *
 * `local` is a 400: the control-plane host updates with the server.
 *
 * The agent restarts, so the caller should hand off to `useNodeRestartWait` —
 * a held node has no `runtime.startedAt` to compare against, and that waiter
 * knows it.
 */
export function useNodeUpdate(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { force?: boolean } = {}) =>
      apiFetch<NodeUpdateStarted>(`/api/nodes/${id}/update`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // The node goes away and comes back on a different binary, so both its own
    // row and the list are stale the moment this returns. The waiter refetches
    // again when it sees the agent return; this is for the interval in
    // between, where the page would otherwise still show the old version.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
    },
  });
}
