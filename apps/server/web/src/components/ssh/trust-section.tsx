import type { NodeDetail, NodeSshTrustPeer } from "@internal/node-admin";
import { Button, cn, errMessage, NodeSshTrustCard } from "@internal/node-admin";
import { RefreshCw } from "lucide-react";
import { useNodes } from "@/hooks/use-nodes";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useRepairSshMachinePin } from "@/hooks/use-ssh";

/** Machine fingerprints and explicit peer-pin repair: agent owners may repair their own pins,
 * while only cookie admins may inspect or change the server's pin store.
 * The displayed copy still needs comparison with each machine through a trusted channel. */
export function SshTrustSection({ node }: { node: NodeDetail }) {
  const { data: nodeData } = useNodes();
  const { data: settings } = usePublicSettings();
  const localAdmin = node.kind === "local" && node.canManage && settings?.viewerIsAdmin === true;
  if ((node.kind === "local" ? !localAdmin : node.access !== "owner" && node.access !== "edit") || !node.sshTrust) {
    return null;
  }
  const machines = Array.isArray(nodeData?.nodes) ? nodeData.nodes : [];
  const peerName = (peerId: string) => machines.find((n) => n.id === peerId)?.name ?? peerId;
  // Foreign agent admins remain edit viewers. Only local has the explicit admin configuration role.
  const isOwner = node.kind === "local" ? localAdmin : node.access === "owner";

  return (
    <div className="space-y-3">
      <NodeSshTrustCard
        node={node}
        allowLocal={localAdmin}
        renderPeerAction={
          isOwner
            ? (peer: NodeSshTrustPeer) => (
                <PeerRepairButton nodeId={node.id} peer={peer} label={peerName(peer.nodeId)} />
              )
            : undefined
        }
      />
      <p className="text-detail text-muted-foreground">
        These fingerprints are reported through this server, for display only. To verify them independently
        (out-of-band), open each machine’s own dashboard and compare its fingerprints with the saved copy on the other
        machine.
      </p>
      {isOwner && node.sshTrust.peers.length > 0 && (
        <p className="text-detail text-muted-foreground">
          A re-pair replaces the stored pin (saved identity) for one peer machine. Verify both machines’ fingerprints
          first. The record names the peer.
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
