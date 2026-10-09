import { BackendErrorCodes } from "@internal/backend-errors";
import { isSshFingerprints, SSH_MAX_SELECTED_FINGERPRINTS } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { ensureDestinationPin, hostPinRefusal, SshHostPinError } from "@/services/ssh-host-pins.service.js";
import { listNodeAgentIdentities, type SshAnswer } from "@/services/ssh-launch.service.js";
import { ensureLocalRelayIdentity } from "@/services/ssh-local-identity.js";
import { gateSshNode } from "@/services/ssh-policy.service.js";
import { getRelayBroker, type RelayPeerKeys, SshRelayRefusal } from "@/services/ssh-relay.service.js";

function refused(refusal: Exclude<SshAnswer<never>, { ok: true }>["refusal"]): SshAnswer<never> {
  return { ok: false, refusal };
}

/** Select current agent identities. Omitted selection uses the whole roster only within the cap. */
export function selectRelayFingerprints(
  roster: readonly { fingerprint: string }[],
  requested?: readonly string[],
): SshAnswer<string[]> {
  if (requested !== undefined && (!Array.isArray(requested) || requested.some((key) => typeof key !== "string"))) {
    return refused({
      status: 400,
      code: BackendErrorCodes.SSH_KEYS_INVALID,
      message: "Select keys from the key machine's current SSH agent roster.",
    });
  }
  const selected = requested === undefined ? roster.map((key) => key.fingerprint) : [...new Set(requested)];
  if (selected.length > SSH_MAX_SELECTED_FINGERPRINTS)
    return refused({
      status: 400,
      code: BackendErrorCodes.SSH_KEYS_OVER_LIMIT,
      message: `Select at most ${SSH_MAX_SELECTED_FINGERPRINTS} SSH keys before connecting. No keys were selected automatically.`,
    });
  if (!isSshFingerprints(selected) || selected.some((key) => !roster.some((item) => item.fingerprint === key))) {
    return refused({
      status: 400,
      code: BackendErrorCodes.SSH_KEYS_INVALID,
      message: "Select keys from the key machine's current SSH agent roster.",
    });
  }
  return { ok: true, value: selected };
}

/** Prepare one user-scoped relay; current launch access on both machines authorizes it. */
export async function prepareRelayLeg(args: {
  viewerId: string;
  aNode: { id: string; name: string };
  bNodeId: string;
  destination: string;
  paneId: string;
  fingerprints?: readonly string[];
}): Promise<SshAnswer<{ socketPath: string; ref: string; fingerprints: string[] }>> {
  for (const nodeId of [args.aNode.id, args.bNodeId]) {
    const gate = await gateSshNode(args.viewerId, nodeId);
    if (!gate.ok) return gate;
  }
  const roster = await listNodeAgentIdentities({ viewerId: args.viewerId, aNodeId: args.aNode.id });
  if (!roster.ok) return roster;
  const selection = selectRelayFingerprints(roster.value.identities, args.fingerprints);
  if (!selection.ok) return selection;
  const selected = selection.value;
  if ([args.aNode.id, args.bNodeId].includes("local")) {
    try {
      await ensureLocalRelayIdentity();
    } catch {
      return refused({
        status: 409,
        code: BackendErrorCodes.SSH_RELAY_IDENTITY_MISSING,
        message:
          "The server relay identity is unavailable or differs from its registration. An admin must restore or repair its SSH identity before connecting.",
      });
    }
  }
  const identities = new IdentitiesRepository(db);
  const [rowA, rowB] = await Promise.all([
    identities.findByPrincipal(`node:${args.aNode.id}`),
    identities.findByPrincipal(`node:${args.bNodeId}`),
  ]);
  // The two halves the broker pairs: the registered ES256 signing JWK and the
  // ECDH-ES encryption JWK, both read from the identities store, never from
  // the caller. A row without either half is the named refusal - the §4.3
  // `ready` bootstrap or a re-enroll is the only thing that fills a slot.
  const peerHalf = (row: typeof rowA): RelayPeerKeys | null =>
    row && row.signingPublicKey !== null
      ? { signingPublicKey: row.signingPublicKey, encryptionPublicJwk: row.publicKey }
      : null;
  const aPeer = peerHalf(rowA);
  const bPeer = peerHalf(rowB);
  if (!aPeer || !bPeer) {
    return refused({
      status: 409,
      code: BackendErrorCodes.SSH_RELAY_IDENTITY_MISSING,
      message:
        "That key home or connecting machine has not registered its relay identity yet. Re-enroll it, or wait for its next check-in to deliver the key.",
    });
  }
  // The pin door (spec §9, Task 12): read the destination's stored pin,
  // capturing from A's `known_hosts` at first open when none stands.
  // Every failure refuses the
  // launch BEFORE any session exists - a relay without a pin would mean B
  // ambient-TOFUing D, which is the one posture the design refuses.
  let hostPin: string;
  try {
    hostPin = (
      await ensureDestinationPin({ ownerUserId: args.viewerId, aNodeId: args.aNode.id, destination: args.destination })
    ).line;
  } catch (err) {
    if (err instanceof SshHostPinError) return refused(hostPinRefusal(err));
    throw err;
  }
  const broker = getRelayBroker();
  let socketPath: string;
  let ref: string;
  try {
    const opened = await broker.openRelay({
      userId: args.viewerId,
      fingerprints: selected,
      paneId: args.paneId,
      aNode: args.aNode.id,
      bNode: args.bNodeId,
      aPeer,
      bPeer,
      hostPin,
    });
    socketPath = opened.socketPath;
    ref = opened.ref;
  } catch (err) {
    if (err instanceof SshRelayRefusal) {
      return refused({
        status: 409,
        code: BackendErrorCodes.SSH_RELAY_OPEN_FAILED,
        message: relayRefusalCopy(err.code),
      });
    }
    throw err;
  }
  for (const nodeId of [args.aNode.id, args.bNodeId]) {
    const gate = await gateSshNode(args.viewerId, nodeId);
    if (!gate.ok) {
      await broker.closeRelay(ref, "access-revoked");
      return gate;
    }
  }
  return { ok: true, value: { socketPath, ref, fingerprints: selected } };
}
/** Human copy per broker refusal code; ids only, never key material or sockets. */
function relayRefusalCopy(code: SshRelayRefusal["code"]): string {
  switch (code) {
    case "access-denied":
      return "SSH launch access changed while the connection was opening. Check access to both machines and retry.";
    case "quota":
      return "That machine already carries its full share of live relay sessions. Wait for one to close and retry.";
    case "handshake":
      return "The key home or the connecting machine did not complete the relay handshake. Check both machines are online and retry.";
    case "node-off":
      return "SSH was switched off on one of the machines between the gate and the relay open.";
    case "no-node":
    case "no-datadir":
      return "One of the machines is not fully connected; retry once it reports in.";
    case "same-node":
      return "The key home and the connecting machine are the same machine; this connection needs no relay.";
    case "bad-socket-path":
      return "The connecting machine answered a socket path the server could not verify. Nothing was launched.";
    case "bad-pane-id":
    case "bad-fingerprints":
      return "The relay refused the session's identifiers as malformed; the launch was refused.";
    case "bad-host-pin":
      return "The relay refused the destination host pin as malformed; the launch was refused.";
  }
}
