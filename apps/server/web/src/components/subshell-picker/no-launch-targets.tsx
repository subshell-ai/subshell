import { useNavigate } from "@tanstack/react-router";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode } from "@/lib/node-enrollment";
import { isOfflineAgent } from "@/lib/node-label";
import type { Node } from "@/types/node";

/**
 * What the launch form says when nothing it can see will take a subshell.
 *
 * It used to be shaped around ONE machine — the control-plane host with
 * launching switched off — and said so: "and no other machine is registered as
 * a node". Maintenance made that sentence false without making it look false
 * (spec 2026-09-14 §6): a person can have three nodes enrolled, every one of
 * them healthy, and land here because somebody is working on them. So it takes
 * the node LIST and answers per machine — what is in the way, and who can move
 * it.
 *
 * **Every route out is offered to whoever could actually complete it.** Adding
 * a node needs a signed-in cookie AND the instance's `allow_node_enrollment`
 * setting; ending a maintenance window and re-sharing the host are manage acts
 * on those rows. A viewer who cannot take a route gets the sentence naming who
 * can, because an offer that ends in a 403 is worse than no offer. The node
 * button is NOT hidden merely because the settings request has not answered:
 * absent reads as allowed, the same default the server applies to an absent
 * row, so the control does not flicker away on every load.
 */
export function NoLaunchTargets({ nodes, onNavigate }: { nodes: Node[]; onNavigate?: () => void }): JSX.Element {
  const navigate = useNavigate();
  const { data: publicSettings } = usePublicSettings();
  const mayAddNode = canAddNode(publicSettings);

  /**
   * Leave for a page that can fix this — closing whatever contains us first.
   *
   * `QuickAddProvider` mounts the launch and workspace dialogs ABOVE every
   * route (`routes/__root.tsx`), so on the rail's quick-add and on `/new` the
   * route changes UNDERNEATH a modal that stays up — still showing this same
   * empty state, over the very page that was supposed to be the answer. A way
   * out that appears to do nothing is the exact failure this component exists
   * to remove.
   */
  function leaveFor(go: () => void): void {
    onNavigate?.();
    go();
  }

  /** Send the reader to one node's page, dialog closed first. */
  function openNode(id: string): void {
    leaveFor(() => void navigate({ to: "/nodes/$id", params: { id } }));
  }

  // Managed nodes in maintenance are the one case with a one-click fix, and
  // the button still NAVIGATES rather than calling the mutation from here.
  // Ending a window re-opens the machine to everyone it is shared with, so it
  // belongs beside the card that states what maintenance means and who
  // declared it — and driving it from inside a dialog would leave the person
  // who threw the switch from the machine's keyboard undone by a button that
  // said nothing about them. One mechanism for both routes out also keeps
  // `leaveFor` the only way this component ever moves, which is what the
  // dialog-left-open bug above cost to learn.
  const endable = nodes.filter((n) => n.maintenance && n.canManage);
  const enableable = nodes.filter((n) => !n.maintenance && n.canLaunch === false && n.canManage);

  return (
    <div className="space-y-4 rounded-lg border border-dashed p-6 text-center">
      <div className="space-y-1">
        <p className="text-sm">No machine can run a subshell</p>
        {nodes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {mayAddNode
              ? "No machine is available to you. Register one as a node, or ask an admin to share the server."
              : // Told to "register one as a node" with no button and no
                // permission, this named the one route it had just hidden.
                "No machine is available to you. Ask an admin to add one, or to share the server with you."}
          </p>
        ) : (
          <div className="space-y-1">
            {nodes.map((node) => (
              <p key={node.id} className="text-muted-foreground text-sm">
                {blockedSentence(node)}
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {endable.map((node) => (
          <Button key={node.id} variant="outline" size="sm" onClick={() => openNode(node.id)}>
            End maintenance on {node.name}
          </Button>
        ))}
        {enableable.map((node) => (
          <Button key={node.id} variant="outline" size="sm" onClick={() => openNode(node.id)}>
            Enable on {node.name}
          </Button>
        ))}
        {mayAddNode && (
          <Button variant="outline" size="sm" onClick={() => leaveFor(() => void navigate({ to: "/nodes" }))}>
            Add a node
          </Button>
        )}
      </div>
      {/* Every hidden route owes a sentence naming who can take it — that is
          the rule this component's docblock states, and the node route was
          the half not honouring it. */}
      {!mayAddNode && nodes.length > 0 && (
        <p className="text-detail text-muted-foreground">
          Adding nodes is turned off on this instance; an admin can add one.
        </p>
      )}
    </div>
  );
}

/**
 * One machine's sentence: what is in the way, and — for a viewer who cannot
 * move it — who can.
 *
 * Maintenance is checked FIRST even on a machine that is also offline. It is
 * the deliberate state, the one with a person behind it, and the one a reader
 * can do something about; "old laptop is offline" on a node somebody put into
 * maintenance would send them to go and wake a machine that would refuse them
 * anyway.
 */
function blockedSentence(node: Node): string {
  if (node.maintenance) {
    if (node.canManage) return `${node.name} is in maintenance.`;
    // The host's manager is an admin rather than an owner: every admin holds
    // management on `local` and nobody "owns" it.
    return `${node.name} is in maintenance; ${node.kind === "local" ? "an admin" : "its owner"} can end it.`;
  }
  if (isOfflineAgent(node)) return `${node.name} is offline.`;
  if (node.canLaunch === false) {
    // Reworded per spec 2026-09-14 §2: the host's launch switch is no longer
    // a switch at all. What is left on that row is its share set, so the
    // sentence names grants rather than an on/off nobody can find.
    return node.canManage
      ? `Nobody is granted launch access on ${node.name}.`
      : `Nobody is granted launch access on ${node.name}; an admin can share it.`;
  }
  return `${node.name} cannot take a subshell right now.`;
}
