import type { NodeDetail, NodeSshTrustPeer } from "@internal/node-admin";
import { Button, cn, NodeSshTrustCard } from "@internal/node-admin";
import { RefreshCw } from "lucide-react";
import { useNodes } from "@/hooks/use-nodes";

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
 * Second, the §4.5 re-pair act: owner-only (`canManage`), one affordance per
 * pinned peer, rendered INSIDE the card's peer rows through the shared
 * card's `renderPeerAction` slot. The copy says what the act does (a re-pair
 * replaces the stored pin; the audit names the peer id only) and there is no
 * "trust anyway" escape to offer. The plane's re-pair ROUTE does not exist
 * yet (T15 report flags the gap), so the button is drawn DISABLED with its
 * reason, house style for an act that cannot answer (the Add-node button's
 * posture): a live button wired to nothing, or to an invented endpoint,
 * would be the lie this surface exists to avoid.
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

  return (
    <div className="space-y-3">
      <NodeSshTrustCard
        node={node}
        renderPeerAction={
          // Owner-only: an `edit` grantee reads the trust, never re-decides
          // it (§4.5); `canManage` is exactly that gate.
          node.canManage
            ? (peer: NodeSshTrustPeer) => (
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  aria-label={`Re-pair ${peerName(peer.nodeId)}`}
                  title="This server does not offer re-pairing yet"
                  className={cn("text-detail")}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Re-pair
                </Button>
              )
            : undefined
        }
      />
      <p className="text-detail text-muted-foreground">
        These values are rendered by the plane, for display only. The out-of-band check happens on the two machines' own
        dashboards, each speaking about its own keys.
      </p>
      {node.canManage && node.sshTrust.peers.length > 0 && (
        <p className="text-detail text-muted-foreground">
          A re-pair replaces the stored pin for one peer. The record names the peer.
        </p>
      )}
    </div>
  );
}
