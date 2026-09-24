import type { Node } from "@internal/node-admin";
import { Button, CardTitle } from "@internal/node-admin";
import { useNavigate } from "@tanstack/react-router";
import type { JSX } from "react";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { canAddNode, NODE_ENROLLMENT_OFF_COPY } from "@/lib/node-enrollment";
import { isOfflineAgent } from "@/lib/node-label";

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
 * on those rows. An offer that ends in a 403 is worse than no offer. The node
 * button is NOT hidden merely because the settings request has not answered:
 * absent reads as allowed, the same default the server applies to an absent
 * row, so the control does not flicker away on every load.
 *
 * *Who gets a sentence.* The maintenance line still names who can end it even
 * for a viewer who cannot. The ungranted-host case does not: its "; an admin
 * can share it" was removed by operator ask (2026-09-24), so a non-manager on
 * an unshared host sees the headline and whichever routes they can actually
 * take — the card stays short where its answer is "wait for someone else"
 * either way.
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
  // The other unlaunchable kind, and the remedy is a SHARE rather than a
  // switch: nothing is in maintenance here, the row simply grants nobody
  // launch access, and the card that used to flip that (`LocalLaunchCard`) is
  // gone — it was share surgery wearing a switch's clothes. So this button
  // names sharing, the same word the non-manager sentence and the route's own
  // 403 use, and lands on the node page whose header opens the dialog. Calling
  // it "Enable on {name}" pointed at a control that page no longer carries,
  // which is the dead end this component exists to not offer.
  const shareable = nodes.filter((n) => !n.maintenance && !n.canLaunch && n.canManage);

  return (
    <div className="space-y-4 rounded-lg border border-dashed p-6 text-center">
      <div className="space-y-1">
        {/* Title level (operator ask 2026-09-24): the SHARED CardTitle, the
            same component every EmptyState card headlines with — this card
            is a dashed empty state wearing divs, and it should meet its
            siblings at the same weight rather than a hand-sized one. */}
        <CardTitle>No machine can run a subshell</CardTitle>
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
            {nodes
              .map((node) => ({ node, line: blockedSentence(node) }))
              .filter((entry) => entry.line !== null)
              .map(({ node, line }) => (
                <p key={node.id} className="text-muted-foreground text-sm">
                  {line}
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
        {shareable.map((node) => (
          <Button key={node.id} variant="outline" size="sm" onClick={() => openNode(node.id)}>
            Share {node.name}
          </Button>
        ))}
        {mayAddNode && (
          <Button variant="outline" size="sm" onClick={() => leaveFor(() => void navigate({ to: "/nodes" }))}>
            Add a node
          </Button>
        )}
      </div>
      {/* The enrollment route stays a SENTENCE for a viewer it hides from —
          unlike the per-host grant case (2026-09-24), this one has no button
          beside it and no other card says it; it was the half this component
          once failed to honour. */}
      {!mayAddNode && nodes.length > 0 && (
        <p className="text-detail text-muted-foreground">{NODE_ENROLLMENT_OFF_COPY}</p>
      )}
    </div>
  );
}

/**
 * One machine's sentence: what is in the way, and — for a viewer who can act
 * on it — what to do. Returns null when there is nothing this viewer can do
 * AND the operator does not want the "who can fix it" line shown (the
 * ungranted-host case below); the caller drops null rows.
 *
 * Maintenance is checked FIRST even on a machine that is also offline. It is
 * the deliberate state, the one with a person behind it, and the one a reader
 * can do something about; "old laptop is offline" on a node somebody put into
 * maintenance would send them to go and wake a machine that would refuse them
 * anyway.
 */
function blockedSentence(node: Node): string | null {
  if (node.maintenance) {
    if (node.canManage) return `${node.name} is in maintenance.`;
    // The host's manager is an admin rather than an owner: every admin holds
    // management on `local` and nobody "owns" it.
    return `${node.name} is in maintenance; ${node.kind === "local" ? "an admin" : "its owner"} can end it.`;
  }
  if (isOfflineAgent(node)) return `${node.name} is offline.`;
  if (!node.canLaunch) {
    // Reworded per spec 2026-09-14 §2: the host's launch switch is no longer
    // a switch at all. What is left on that row is its share set, so the
    // sentence names grants rather than an on/off nobody can find. Only the
    // manager who CAN act gets the sentence; the non-manager's "; an admin can
    // share it" was removed (operator ask 2026-09-24) — the card and its one
    // remaining route carry that case instead.
    return node.canManage
      ? `Nobody is granted launch access on ${node.name}. Share it with Everyone or with specific people to allow launching.`
      : null;
  }
  return `${node.name} cannot take a subshell right now.`;
}
