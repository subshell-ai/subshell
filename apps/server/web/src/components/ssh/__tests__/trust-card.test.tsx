import { afterEach, describe, expect, it } from "bun:test";
import type { NodeDetail } from "@internal/node-admin";
import { cleanup, render, screen } from "@testing-library/react";
import { SshTrustCard } from "@/components/ssh/trust-card";

/**
 * The node page's §4.6 machine trust card (spec 2026-10-08). The card is
 * pure prop rendering: the GATE lives on the server (the field is absent for
 * a `view` grantee and on `local`, never null), and the card's own check is
 * belt-not-control - a payload that arrived against the rule must still not
 * render. The fingerprints are public display of the trust the machines
 * enforce as byte equality; the card exists for the out-of-band compare
 * against what the PEER machine prints about itself.
 */

const FP_OWN_SIGN = `SHA256:${"A".repeat(43)}`;
const FP_OWN_ENC = `SHA256:${"B".repeat(43)}`;
const FP_PEER_SIGN = `SHA256:${"C".repeat(43)}`;
const FP_PEER_ENC = `SHA256:${"D".repeat(43)}`;
const PEER_ID = "0f8e2c1a-0000-4000-8000-000000000001";

function node(over: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "node1",
    name: "box",
    kind: "agent",
    os: "linux",
    arch: "x64",
    hostname: "box",
    status: "online",
    lastSeenAt: null,
    agentVersion: "1.0.0",
    protocolVersion: 18,
    access: "owner",
    canManage: true,
    canLaunch: true,
    capabilities: [],
    allowedDirs: [],
    harnesses: [],
    inventoryStale: false,
    maintenance: false,
    maintenanceAt: null,
    maintenanceSource: null,
    sshEnabled: false,
    held: null,
    ...over,
  };
}

const LIVE_TRUST = {
  own: { signing: FP_OWN_SIGN, encryption: FP_OWN_ENC },
  peers: [{ nodeId: PEER_ID, signing: FP_PEER_SIGN, encryption: FP_PEER_ENC }],
  stale: false,
};

afterEach(cleanup);

describe("SshTrustCard", () => {
  it("owner with a live block: own and peer fingerprints, no stale marking", () => {
    const { container } = render(<SshTrustCard node={node({ sshTrust: LIVE_TRUST })} />);
    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText("Machine trust")).toBeDefined();
    expect(screen.getByText(FP_OWN_SIGN)).toBeDefined();
    expect(screen.getByText(FP_OWN_ENC)).toBeDefined();
    expect(screen.getByText(`Peer ${PEER_ID}`)).toBeDefined();
    expect(screen.getByText(FP_PEER_SIGN)).toBeDefined();
    expect(screen.getByText(FP_PEER_ENC)).toBeDefined();
    expect(screen.queryByText(/stale/i)).toBeNull();
  });

  it("an edit grantee sees the same card the owner sees", () => {
    render(<SshTrustCard node={node({ access: "edit", canManage: false, sshTrust: LIVE_TRUST })} />);
    expect(screen.getByText(FP_OWN_SIGN)).toBeDefined();
  });

  it("the stale mirror renders STALE-marked, distinguishable from live", () => {
    render(<SshTrustCard node={node({ status: "offline", sshTrust: { ...LIVE_TRUST, stale: true } })} />);
    // The flag carries both a badge and its own sentence: the §4.6 compare is
    // exactly the thing a reader must not do against a last-known value
    // thinking it current.
    expect(screen.getByText(/offline/i)).toBeDefined();
    expect(screen.getByText(FP_OWN_SIGN)).toBeDefined();
  });

  it("a view grantee never gets the card, absent field or not", () => {
    // The server's gate leaves the field OFF the payload for this viewer; the
    // card's own kind/access check is the belt, pinned here so a future
    // refactor of the route's gate cannot silently widen what this renders.
    const { container } = render(<SshTrustCard node={node({ access: "view", canManage: false })} />);
    expect(container.firstChild).toBeNull();
    const belt = render(<SshTrustCard node={node({ access: "view", canManage: false, sshTrust: LIVE_TRUST })} />);
    expect(belt.container.firstChild).toBeNull();
  });

  it("never on `local`, not even with a block that must not have serialized", () => {
    const { container } = render(<SshTrustCard node={node({ kind: "local", sshTrust: LIVE_TRUST })} />);
    expect(container.firstChild).toBeNull();
  });

  it("no block on the view means no card (older agent, nothing reported yet)", () => {
    const { container } = render(<SshTrustCard node={node()} />);
    expect(container.firstChild).toBeNull();
  });

  it("an empty peer set says so plainly instead of rendering a lone header", () => {
    render(<SshTrustCard node={node({ sshTrust: { ...LIVE_TRUST, peers: [] } })} />);
    expect(screen.getByText(FP_OWN_SIGN)).toBeDefined();
    expect(screen.getByText(/no ssh relay peers pinned yet/i)).toBeDefined();
  });
});
