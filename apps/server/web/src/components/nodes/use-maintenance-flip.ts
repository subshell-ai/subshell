import type { Node, NodeDetail } from "@internal/node-admin";
import {
  confirmStartMaintenance,
  errMessage,
  maintenanceRefusalNotice,
  nodeDetailQuery,
  useSetNodeMaintenance,
} from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";

/**
 * Bind "start or end maintenance" to one node, as one callable.
 *
 * Both list views on `/nodes` — the card row and the table row — offer the
 * flip, and neither can inline it: the mutation is keyed by THIS node's id
 * and a hook cannot be called inside a `map`, so each row is a small
 * container that calls this once. One implementation is also what keeps the
 * two views from answering "what does starting maintenance cost"
 * differently: the confirmation counts, the refusal notice and the cache
 * fallout are the same act whichever row threw the switch.
 *
 * **The count is fetched at the moment it is asked for.** Starting
 * maintenance stops every subshell on the machine, so the prompt has to say
 * how many — and `runningSubshells` rides the DETAIL view only,
 * manager-only, because it exists solely to answer this question. The list
 * payload has never carried it. Reading it through the query cache means a
 * page that already holds a fresh detail pays nothing, and a row acting from
 * a cold list pays one request for a number that is true.
 *
 * A detail read that FAILS does not block the act: it says nothing about
 * whether the flip would work, so the prompt hedges ("Any subshells running
 * here…") and the server stays the gate.
 *
 * @param node - The node the returned callable flips
 * @param onError - Says something on the page's one message line; null clears it
 * @returns A callable for the row's menu item
 */
export function useMaintenanceFlip(node: Node, onError: (message: string | null) => void): () => void {
  const queryClient = useQueryClient();
  const setMaintenance = useSetNodeMaintenance(node.id);

  /**
   * The fallout the SHARED card hook no longer reaches. Flipping maintenance
   * terminates subshells on that machine, and the rows this viewer can see
   * went `terminated` the instant the PUT answered — on the plane that means
   * the sidebar list must learn now, not on its next incidental refetch. The
   * node-admin card takes this as a prop for the same reason; a list row has
   * no card, so it says it here. (The node's own dashboard has no subshell
   * query, which is exactly why the hook left it out.)
   */
  function reportFlip() {
    void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
  }

  async function flip(): Promise<void> {
    onError(null);
    if (node.maintenance) {
      // Ending only widens what the machine accepts — nothing to ask.
      setMaintenance.mutate(false, {
        onSuccess: (result) => {
          reportFlip();
          onError(maintenanceRefusalNotice(node.name, result.failed));
        },
        onError: (err) => onError(errMessage(err, `Couldn't end maintenance on ${node.name}.`)),
      });
      return;
    }
    let runningSubshells: number | undefined;
    try {
      const detail: NodeDetail = await queryClient.fetchQuery(nodeDetailQuery(node.id));
      runningSubshells = detail.runningSubshells;
    } catch {
      // Left undefined on purpose; the prompt has a shape for "not known".
    }
    const ok = await confirmStartMaintenance({
      name: node.name,
      isLocal: node.kind === "local",
      runningSubshells,
    });
    if (!ok) return;
    setMaintenance.mutate(true, {
      onSuccess: (result) => {
        reportFlip();
        onError(maintenanceRefusalNotice(node.name, result.failed));
      },
      onError: (err) => onError(errMessage(err, `Couldn't start maintenance on ${node.name}.`)),
    });
  }

  return () => void flip();
}
