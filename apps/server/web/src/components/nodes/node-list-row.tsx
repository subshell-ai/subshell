import { useQueryClient } from "@tanstack/react-query";
import type { JSX } from "react";
import { NodeRow } from "@/components/nodes/node-row";
import { nodeDetailQuery, useSetNodeMaintenance } from "@/hooks/use-nodes";
import { errMessage } from "@/lib/api";
import { confirmStartMaintenance } from "@/lib/node-confirmations";
import { maintenanceRefusalNotice } from "@/lib/node-maintenance";
import type { Node, NodeDetail } from "@/types/node";

/**
 * One row of the Nodes list with its maintenance flip bound to it.
 *
 * `NodeRow` stays presentation — entity knowledge belongs to the caller, the
 * rule `ActionsMenu` states — but this particular action cannot live on the
 * page either: the mutation is keyed by THIS row's id, and a hook cannot be
 * called inside a `map`. One container per row is what React gives for that,
 * and it buys the second thing the page could not do.
 *
 * **The count is fetched at the moment it is asked for.** Starting maintenance
 * stops every subshell on the machine, so the prompt has to say how many —
 * and `runningSubshells` rides the DETAIL view only, manager-only, because it
 * exists solely to answer this question. The list payload has never carried
 * it. Reading it through the query cache means a page that already holds a
 * fresh detail pays nothing, and a row acting from a cold list pays one
 * request for a number that is true.
 *
 * A detail read that FAILS does not block the act: it says nothing about
 * whether the flip would work, so the prompt hedges ("Any subshells running
 * here…") and the server stays the gate.
 */
export function NodeListRow({
  node,
  onOpenConfig,
  onShare,
  onDelete,
  onError,
}: {
  /** The node this row renders */
  node: Node;
  /** Open this node's config page */
  onOpenConfig: () => void;
  /** Open this node's sharing management (owner-only server-side) */
  onShare: () => void;
  /** Delete this node (owner-only server-side) */
  onDelete: () => void;
  /**
   * Say something on the page's one message line; null clears it.
   *
   * Two things travel here, and both have to: the server's refusal, and a flip
   * that LANDED while the node refused to kill some of what was running on it.
   * The second reads as a success everywhere else on this row — the badge
   * flips, the menu item changes — so dropping it tells the person a machine
   * is quiet when panes are still alive there.
   */
  onError: (message: string | null) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const setMaintenance = useSetNodeMaintenance(node.id);

  async function flip(): Promise<void> {
    onError(null);
    if (node.maintenance) {
      // Ending only widens what the machine accepts — nothing to ask.
      setMaintenance.mutate(false, {
        onSuccess: (result) => onError(maintenanceRefusalNotice(node.name, result.failed)),
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
      onSuccess: (result) => onError(maintenanceRefusalNotice(node.name, result.failed)),
      onError: (err) => onError(errMessage(err, `Couldn't start maintenance on ${node.name}.`)),
    });
  }

  return (
    <NodeRow
      node={node}
      onOpenConfig={onOpenConfig}
      onShare={onShare}
      onDelete={onDelete}
      onMaintenance={() => void flip()}
    />
  );
}
