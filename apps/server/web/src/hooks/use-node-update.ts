import { apiFetch, errMessage, NODE_QUERY_KEY, NODES_QUERY_KEY } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { UPDATES_QUERY_KEY } from "@/lib/query-keys";

/** What `POST /api/nodes/:id/update` answers on 202. */
export interface NodeUpdateStarted {
  ok: true;
  /** The node version that machine was running. */
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

/** What {@link useNodeUpdate} hands the Nodes rows and the node page card. */
export interface NodeUpdate {
  /** Ask one node to replace its own binary. Resolves on the 202; rejects on a refusal. */
  update(nodeId: string, opts?: { force?: boolean }): Promise<NodeUpdateStarted>;
  /** Node ids whose POST is in flight through this hook instance. A SET,
   * because one instance now drives a whole batch: a single-call
   * `useMutation` could name only its latest variables, which is what left
   * every "Update all" but the first row silent for minutes (operator
   * report 2026-09-25, and the reason the old sequence owned its own
   * activeId - this makes that per-tab bookkeeping unnecessary). */
  pendingNodeIds: ReadonlySet<string>;
  /** Why a node's last attempt was REFUSED, per node. Covers the refusals
   * that land before the route opens a tracker entry (offline, too old,
   * would kill panes) and so have no server-side story; the tracker's
   * sentence wins wherever both exist (the rows' suppression rule). */
  failures: Readonly<Record<string, string>>;
  /** Forget every remembered failure - the rows clear them when a new run
   * starts, so a refusal from before never stays pinned on a row the new
   * run did not even ask. */
  reset(): void;
}

/**
 * `POST /api/nodes/:id/update` — replace one node's own binary (spec
 * 2026-09-15 §5.3).
 *
 * **This is the action a HELD node exists for.** A node the server refuses
 * for its version or protocol is no longer dropped — its socket is held open
 * for this one command — so `node.held` being non-null is precisely when this
 * is both possible and the only thing that helps. It also works on an online
 * node that is simply behind. `local` is a 400: the host updates with the
 * server. 409s carry the refusal: `NODE_OFFLINE`, `NODE_UPDATE_UNAVAILABLE`,
 * `NODE_AGENT_TOO_OLD` (remedy: `subshell update` at that machine),
 * `NODE_NOT_SUPERVISED`, `NODE_RESTART_KILLS_PANES` (`force` overrides) and
 * `NODE_UPDATE_FAILED` — on which the node's binary is untouched.
 *
 * **One instance drives many nodes at once** (spec 2026-09-30): "Update all"
 * fires its whole batch through this one hook, so busy and failure are
 * per-node collections, not a mutation's single latest call. It rejects
 * rather than swallowing, because the caller is a BATCH: `Promise.allSettled`
 * keeps every row's outcome independent, and a hook that resolved on a
 * refusal would report a stopped machine as a finished one.
 */
export function useNodeUpdate(): NodeUpdate {
  const queryClient = useQueryClient();
  const [pendingNodeIds, setPendingNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  async function update(nodeId: string, opts?: { force?: boolean }): Promise<NodeUpdateStarted> {
    setPendingNodeIds((cur) => new Set(cur).add(nodeId));
    setFailures((cur) => {
      if (cur[nodeId] === undefined) return cur;
      const next = { ...cur };
      delete next[nodeId];
      return next;
    });
    try {
      const result = await apiFetch<NodeUpdateStarted>(`/api/nodes/${nodeId}/update`, {
        method: "POST",
        body: JSON.stringify(opts?.force === true ? { force: true } : {}),
      });
      // The node exits to be respawned, so its row is about to change twice:
      // offline, then online on the new version.
      void queryClient.invalidateQueries({ queryKey: UPDATES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, nodeId] });
      return result;
    } catch (err) {
      setFailures((cur) => ({ ...cur, [nodeId]: errMessage(err, "The update was refused.") }));
      throw err;
    } finally {
      setPendingNodeIds((cur) => {
        if (!cur.has(nodeId)) return cur;
        const next = new Set(cur);
        next.delete(nodeId);
        return next;
      });
    }
  }

  function reset(): void {
    setFailures({});
  }

  return { update, pendingNodeIds, failures, reset };
}
