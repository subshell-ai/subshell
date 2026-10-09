import type { NodeDetail, NodeSshTrustPeer } from "@internal/node-admin";
import { Button, cn, errMessage, NodeSshTrustCard } from "@internal/node-admin";
import { RefreshCw } from "lucide-react";
import { useNodes } from "@/hooks/use-nodes";
import { useRepairSshMachinePin } from "@/hooks/use-ssh";

/**
 * The plane's machine-trust surface on a node's page (spec 2026-10-08
 * §4.5-§4.6): the shared trust card, plus the two things the plane OWNS on
 * top of it and the card (being shared with the machine's own dashboard)
 * must not carry.
 *
 * First, honesty: the values below are rendered BY THE PLANE, and the §4.6
 * check counts only where a machine speaks about its own keys - its loopback
 * dashboard. The line is on this surface and never on the dashboard half,
 * which is exactly the surface the check happens ON.
 *
 * Second, the §4.5 re-pair act: one affordance per pinned peer, rendered
 * INSIDE the card's peer rows through the shared card's `renderPeerAction`
 * slot, calling `POST /api/nodes/:id/machine-pins/:peer/repair`. Gated on
 * the SAME exact-owner test the route runs (`access === "owner"`), not
 * `canManage`: re-authorizing a peer's key is a trust act, so an `edit`
 * grantee reads the trust and never re-decides it, and the seeded-local
 * manage exception must not reach here either (the card never renders on
 * `local`). The copy says what the act does - a re-pair replaces the stored
 * pin for one peer, audited naming the peer id - and there is no "trust
 * anyway" escape to offer. The route refuses an offline machine by name
 * (409 NODE_OFFLINE), and the refusal is shown under the button, in the
 * button's own failure state, not in a banner.
 */
export function SshTrustSection({ node }: { node: NodeDetail }) {
  const { data: nodeData } = useNodes();
  // The card's own double gate, mirrored so the plane-only additions appear
  // exactly where the card does and nowhere else: owner/`edit` on an AGENT
  // node holding a trust block. `view` and `local` render NOTHING here.
  if (node.kind !== "agent" || (node.access !== "owner" && node.access !== "edit") || !node.sshTrust) {
    return null;
  }
  const machines = Array.isArray(nodeData?.nodes) ? nodeData.nodes : [];
  const peerName = (peerId: string) => machines.find((n) => n.id === peerId)?.name ?? peerId;
  // EXACTLY the owner (the route checks the same fact against the row): an
  // admin viewing a foreign agent resolves to `edit` here and sees no act.
  const isOwner = node.access === "owner";

  return (
    <div className="space-y-3">
      <NodeSshTrustCard
        node={node}
        renderPeerAction={
          isOwner
            ? (peer: NodeSshTrustPeer) => (
                <PeerRepairButton nodeId={node.id} peer={peer} label={peerName(peer.nodeId)} />
              )
            : undefined
        }
      />
      <p className="text-detail text-muted-foreground">
        These values are rendered by the plane, for display only. The out-of-band check happens on the two machines' own
        dashboards, each speaking about its own keys.
      </p>
      {isOwner && node.sshTrust.peers.length > 0 && (
        <p className="text-detail text-muted-foreground">
          A re-pair replaces the stored pin for one peer. The record names the peer.
        </p>
      )}
    </div>
  );
}

/**
 * One peer's re-pair act: the button posts the repair for exactly its own
 * peer id. While pending it is disabled and spinning (the process names
 * itself); a refusal renders on the button that failed, in `detail` red -
 * the machine's own words as the server's message says them, never key
 * bytes; a success says the pin was replaced and the detail refetch settles
 * the card once the machine re-reports its trust block.
 */
function PeerRepairButton({ nodeId, peer, label }: { nodeId: string; peer: NodeSshTrustPeer; label: string }) {
  const repair = useRepairSshMachinePin(nodeId);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={repair.isPending}
        aria-label={`Re-pair ${label}`}
        title={`Replaces ${label}'s stored pin with its current registered keys`}
        className={cn("text-detail")}
        onClick={() => repair.mutate(peer.nodeId)}
      >
        <RefreshCw className={cn("h-3.5 w-3.5", repair.isPending && "animate-spin")} /> Re-pair
      </Button>
      {repair.isError && (
        <p className="text-destructive text-detail">{errMessage(repair.error, "The re-pair did not land.")}</p>
      )}
      {repair.isSuccess && <p className="text-detail text-muted-foreground">Pin replaced for {label}.</p>}
    </div>
  );
}
