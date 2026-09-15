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
}

/** What {@link useNodeUpdate} hands the Nodes card. */
export interface NodeUpdate {
  /** Ask one node to replace its agent binary. Resolves on the 202; rejects on a refusal. */
  update(nodeId: string, opts?: { force?: boolean }): Promise<NodeUpdateStarted>;
  /** The node whose update is in flight, or null. */
  pendingNodeId: string | null;
  /** Why the last attempt failed, and on which node; null when none has. */
  failure: { nodeId: string; message: string } | null;
  /** Forget the last failure — the card clears it when a new run starts. */
  reset(): void;
}

/**
 * `POST /api/nodes/:id/update` — replace one node's agent binary (spec
 * 2026-09-15 §5.3).
 *
 * **The route is Phase C's and does not exist yet.** This hook is written
 * against its URL and its body so that landing it is a matter of flipping
 * `canUpdate.ok` on the rows, not of writing the client half then. Until then
 * every row's button is disabled with `canUpdate.reason`, so nothing here is
 * reachable from the page.
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
