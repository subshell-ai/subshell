import { Badge, Card, CardContent, CardHeader, CardTitle, CopyableValue, type NodeDetail } from "@internal/node-admin";
import type { JSX } from "react";

/**
 * The machine trust card (spec 2026-10-08 §4.6): this machine's own SSH relay
 * key fingerprints and each pinned peer's, for the out-of-band compare.
 *
 * The check this serves is deliberately NOT a green tick: the only honest
 * reading is a person comparing these strings against what the OTHER machine
 * prints about the SAME keys on its own surface (the node dashboard side, fed
 * from the machine's key files). Fingerprints are public display of the trust
 * the machines enforce as byte equality; nothing here is key material, and
 * nothing here proves anything until both machines have been read.
 *
 * Gated twice over, on purpose. The server omits `sshTrust` for a `view`
 * grantee and on `local` entirely (it is machine-relationship disclosure, the
 * same class as the runtime block), and this component refuses the same two
 * cases so a payload that arrived against the rule still renders nothing.
 *
 * Staleness is not the gate: an OFFLINE agent renders the durable mirror, and
 * says so plainly, because comparing last-known fingerprints during an
 * incident is exactly when the card earns its keep and exactly when reading a
 * stale value as current would mislead.
 */
export function SshTrustCard({ node }: { node: NodeDetail }): JSX.Element | null {
  if (node.kind !== "agent" || (node.access !== "owner" && node.access !== "edit")) return null;
  const trust = node.sshTrust;
  if (!trust) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Machine trust
          {trust.stale && <Badge variant="warning">Stale</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-detail text-muted-foreground">
          {trust.stale
            ? "This machine is offline. These are the last fingerprints it reported."
            : "Fingerprints of this machine's relay keys and every peer it pins. Compare them against what each machine prints about the same keys itself."}
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
            <div className="col-span-full">
              <dt className="text-muted-foreground">Pinned peers</dt>
              <dd className="mt-1 text-detail text-muted-foreground">No SSH relay peers pinned yet.</dd>
            </div>
          ) : (
            trust.peers.map((peer) => (
              <div key={peer.nodeId} className="col-span-full">
                <dt className="text-muted-foreground">Peer {peer.nodeId}</dt>
                <dd className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FingerprintValue value={peer.signing} copyLabel={`Peer ${peer.nodeId} signing fingerprint`} />
                  <FingerprintValue value={peer.encryption} copyLabel={`Peer ${peer.nodeId} encryption fingerprint`} />
                </dd>
              </div>
            ))
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

/** One labelled fingerprint: `label` over a mono `detail`, the line-item shape. */
function FingerprintFact({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono">
        <FingerprintValue value={value} copyLabel={copyLabel} />
      </dd>
    </div>
  );
}

/** The value plus its copy affordance, the thing a person takes to the other machine. */
function FingerprintValue({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <span className="break-all text-detail">
      <CopyableValue value={value} label={copyLabel} />
    </span>
  );
}
