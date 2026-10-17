import type { JSX, ReactNode } from "react";
import type { NodeDetail, NodeSshTrustPeer } from "../types/node";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { CopyableValue } from "../ui/copyable-value";
import { Fact } from "./fact-list";

/**
 * The machine trust card (spec 2026-10-08 §4.6): this machine's own SSH relay
 * key fingerprints and each pinned peer's, for the out-of-band compare.
 *
 * The check this serves is deliberately NOT a green tick: the only honest
 * reading is a person comparing these strings against what the OTHER machine
 * prints about the SAME keys on its own surface. That is why this card lives
 * in the shared package: the §4.6 compare happens on the TWO MACHINES' OWN
 * loopback dashboards, where the page is fed from the machine's own key
 * files, and the plane shows the same card as a convenience copy of what a
 * connected (or last-connected) agent reported. Fingerprints are public
 * display of the trust the machines enforce as byte equality; nothing here is
 * key material, and nothing here proves anything until both machines have
 * been read.
 *
 * Agent trust requires owner/edit access. The control plane may opt its local
 * row in for an authenticated admin through `allowLocal`; its canManage check
 * remains a second gate. Node dashboards retain the agent-only default.
 *
 * Staleness is not the gate: an OFFLINE agent renders the durable mirror, and
 * says so plainly, because comparing last-known fingerprints during an
 * incident is exactly when the card earns its keep and exactly when reading a
 * stale value as current would mislead.
 *
 * `renderPeerAction` is the plane's slot (Task 15): the re-pair act belongs
 * to the control plane's owner gate, not to the card, so the CARD stays a
 * pure display and the node's own dashboard renders no action by never
 * passing the prop. It renders inside the peer's row, so the act sits on the
 * facts it acts on.
 */
export function NodeSshTrustCard({
  node,
  renderPeerAction,
  allowLocal = false,
  embedded = false,
}: {
  node: NodeDetail;
  renderPeerAction?: (peer: NodeSshTrustPeer) => ReactNode;
  /** The control plane opts in only for an authenticated admin; node dashboards remain agent-only. */
  allowLocal?: boolean;
  /** Render inside an existing SSH card without nesting another card. */
  embedded?: boolean;
}): JSX.Element | null {
  if (node.kind === "local" ? !allowLocal || !node.canManage : node.access !== "owner" && node.access !== "edit")
    return null;
  const trust = node.sshTrust;
  if (!trust) return null;
  const content = (
    <>
      <CardHeader className={embedded ? "p-0" : undefined}>
        <CardTitle className="flex items-center gap-2">
          SSH machine identities
          {trust.stale && <Badge variant="warning">Stale</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className={embedded ? "p-0" : undefined}>
        <p className="text-detail text-muted-foreground">
          {trust.stale
            ? "This machine is offline. These are the last fingerprints it reported."
            : "These fingerprints identify this machine and its saved SSH relay peers. Compare them with the fingerprints shown on each machine's own dashboard."}
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <FingerprintFact
            label="Signing key (this machine)"
            value={trust.own.signing}
            copyLabel="This machine's signing fingerprint"
          />
          <FingerprintFact
            label="Encryption key (this machine)"
            value={trust.own.encryption}
            copyLabel="This machine's encryption fingerprint"
          />
          {trust.peers.length === 0 ? (
            <Fact label="Saved machine identities" wide>
              No saved machine identities yet.
            </Fact>
          ) : (
            trust.peers.map((peer) => (
              <Fact key={peer.nodeId} label={`Peer ${peer.nodeId}`} wide>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FingerprintValue value={peer.signing} copyLabel={`Peer ${peer.nodeId} signing fingerprint`} />
                  <FingerprintValue value={peer.encryption} copyLabel={`Peer ${peer.nodeId} encryption fingerprint`} />
                </div>
                {renderPeerAction && <div className="mt-2">{renderPeerAction(peer)}</div>}
              </Fact>
            ))
          )}
        </dl>
      </CardContent>
    </>
  );
  return embedded ? <section className="flex flex-col gap-3">{content}</section> : <Card>{content}</Card>;
}

/** Fingerprints use the same label/value hierarchy as other machine facts. */
function FingerprintFact({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  return (
    <Fact label={label} mono>
      <FingerprintValue value={value} copyLabel={copyLabel} />
    </Fact>
  );
}

/** The value plus its copy affordance, the thing a person takes to the other machine. */
function FingerprintValue({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <span className="break-all font-mono text-body">
      <CopyableValue value={value} label={copyLabel} />
    </span>
  );
}
