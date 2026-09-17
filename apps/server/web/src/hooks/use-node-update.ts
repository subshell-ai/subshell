import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, errMessage } from "@/lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY, UPDATES_QUERY_KEY } from "@/lib/query-keys";

/** What `POST /api/nodes/:id/update` answers on 202. */
export interface NodeUpdateStarted {
  ok: true;
  /** The agent version that machine was running. */
  from: string;
  /** The version it is installing. */
  to: string;
  /**
   * The download URL the node was given, WITHOUT its single-use token. Echoed
   * because it is built from this server's `APP_BASE_URL` — the same base the
   * enroll script bakes, with the same loopback trap — so a page can warn
   * when a remote machine has been told to fetch from `127.0.0.1`.
   */
  url: string;
}

/** What {@link useNodeUpdate} hands the Nodes rows. */
export interface NodeUpdate {
  /** Ask one node to replace its agent binary. Resolves on the 202; rejects on a refusal. */
  update(nodeId: string, opts?: { force?: boolean }): Promise<NodeUpdateStarted>;
  /** The node whose update is in flight, or null. */
  pendingNodeId: string | null;
  /** Why the last attempt failed, and on which node; null when none has. */
  failure: { nodeId: string; message: string } | null;
  /** Forget the last failure — the rows clear it when a new run starts. */
  reset(): void;
}

/**
 * `POST /api/nodes/:id/update` — replace one node's agent binary (spec
 * 2026-09-15 §5.3).
 *
 * **This is the action a HELD node exists for.** An agent the server refuses
 * for its version or protocol is no longer dropped — its socket is held open
 * for this one command — so `node.held` being non-null is precisely when this
 * is both possible and the only thing that helps. It also works on an online
 * node that is simply behind. `local` is a 400: the host updates with the
 * server. 409s carry the refusal: `NODE_OFFLINE`, `NODE_UPDATE_UNAVAILABLE`,
 * `NODE_AGENT_TOO_OLD` (remedy: `subshell update` at that machine),
 * `NODE_NOT_SUPERVISED`, `NODE_RESTART_KILLS_PANES` (`force` overrides) and
 * `NODE_UPDATE_FAILED` — on which the node's binary is untouched.
 *
 * It rejects rather than swallowing, because the caller is a SEQUENCE: "Update
 * all" stops at the first failure and names the node, and a hook that resolved
 * on a refusal would march the rest of the fleet past a problem.
 */
export function useNodeUpdate(): NodeUpdate {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ nodeId, force }: { nodeId: string; force?: boolean }) =>
      apiFetch<NodeUpdateStarted>(`/api/nodes/${nodeId}/update`, {
        method: "POST",
        body: JSON.stringify(force === true ? { force: true } : {}),
      }),
    onSuccess: (_result, { nodeId }) => {
      // The agent exits to be respawned, so its row is about to change twice:
      // offline, then online on the new version.
      void queryClient.invalidateQueries({ queryKey: UPDATES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, nodeId] });
    },
  });

  return {
    update: (nodeId, opts) => mutation.mutateAsync({ nodeId, force: opts?.force }),
    pendingNodeId: mutation.isPending ? (mutation.variables?.nodeId ?? null) : null,
    failure:
      mutation.error && mutation.variables
        ? { nodeId: mutation.variables.nodeId, message: errMessage(mutation.error, "The update was refused.") }
        : null,
    reset: () => mutation.reset(),
  };
}
