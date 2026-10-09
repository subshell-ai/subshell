import { BackendErrorCodes } from "@internal/backend-errors";
import type { SshMachinePinRepairCommand } from "@internal/subshell-protocol";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { SshRpcError, sshMachinePinRepair } from "@/services/nodes/ssh-rpc.js";
import { ensureLocalRelayIdentity } from "@/services/ssh-local-identity.js";
import { base64OfJwk } from "@/services/ssh-relay.service.js";
import { logger } from "@/utils/logger.js";

/**
 * Explicit machine trust repair: only the enrolled node's owner, or an admin
 * managing the server host, may replace a peer pin. The peer's registered
 * public keys are delivered through the signed node command or the trusted
 * local call boundary. Either kind of machine may be the peer. Success is
 * audited only after the machine acknowledges; no key bytes enter the audit.
 */

/** Why a re-pair refused; each code names its own door (the route renders the copy). */
export type SshMachinePinRepairFailure =
  | "not-owner"
  | "no-node"
  | "same-node"
  | "no-peer"
  | "peer-identity-missing"
  | "offline"
  | "unsupported"
  | "timeout"
  | "refused"
  | "malformed";

/** The loud refusal every re-pair raises. Nothing is written or audited after one. */
export class SshMachinePinRepairError extends Error {
  readonly code: SshMachinePinRepairFailure;
  /** The node the refusal is about (A or the peer, depending on the door). */
  readonly nodeId: string;

  constructor(code: SshMachinePinRepairFailure, message: string, nodeId: string) {
    super(message);
    this.name = "SshMachinePinRepairError";
    this.code = code;
    this.nodeId = nodeId;
  }
}

/** The service's world. Production at {@link defaultRepairDeps}; tests install a fake. */
export interface SshMachinePinsDeps {
  /**
   * Deliver the signed re-pair command to A (default: `ssh-rpc.sshMachinePinRepair`).
   * A test seam so the service's fail-closed behavior never touches a socket.
   */
  sendRepair?(nodeId: string, cmd: SshMachinePinRepairCommand): Promise<{ repaired: true; peerNodeId: string }>;
}

let depsOverride: SshMachinePinsDeps | null = null;

function repairDeps(): SshMachinePinsDeps {
  return depsOverride ?? {};
}

/**
 * Install (or with null, drop) the whole seam.
 * @internal test-only - the suite pins owner/offline/audit behavior without a node.
 */
export function setSshMachinePinsDepsForTests(deps: SshMachinePinsDeps | null): void {
  depsOverride = deps;
}

/**
 * Re-pair one peer on one machine. The full act: owner + eligibility checks,
 * read the peer's registered public pair, send the signed command (A online,
 * ack echoed by equality), audit ids-only. Raises {@link
 * SshMachinePinRepairError} with the named cause on every fail-closed door,
 * writing NOTHING on any of them.
 *
 * @param actorUserId - the cookie human performing the act; must OWN A
 * @param nodeId - A: the machine whose pin store is repaired
 * @param peerNodeId - the peer whose stored entry the command re-delivers for
 */
export async function repairMachinePin(args: {
  actorUserId: string;
  nodeId: string;
  peerNodeId: string;
}): Promise<void> {
  const { actorUserId, nodeId, peerNodeId } = args;
  const { repos } = getRequestlessContext();

  const aRow = await repos.nodes.findById(nodeId);
  if (!aRow) throw new SshMachinePinRepairError("no-node", `node "${nodeId}" has no row`, nodeId);
  const canRepair =
    aRow.kind === "local"
      ? (await loadNodeGate(actorUserId, nodeId))?.isAdmin === true
      : aRow.ownerUserId === actorUserId;
  if (!canRepair)
    throw new SshMachinePinRepairError("not-owner", "Only this machine's manager may repair its trust", nodeId);
  if (peerNodeId === nodeId) {
    // A machine pinning ITSELF is a contradiction the pairing design has no
    // word for (the node refuses it too - both doors name it before a byte
    // moves).
    throw new SshMachinePinRepairError("same-node", "a machine is never its own relay peer", nodeId);
  }

  // The peer: an existing machine with a complete registered identity.
  // Foreign ownership of the peer is no obstacle - the act re-delivers what
  // the peer's own enrollment registered, to a store its owner commands.
  const peerRow = await repos.nodes.findById(peerNodeId);
  if (!peerRow) throw new SshMachinePinRepairError("no-peer", `peer node "${peerNodeId}" has no row`, peerNodeId);
  if (peerNodeId === LOCAL_NODE_ID) {
    try {
      await ensureLocalRelayIdentity();
    } catch {
      throw new SshMachinePinRepairError(
        "peer-identity-missing",
        "The server relay identity needs administrator recovery",
        peerNodeId,
      );
    }
  }
  const identity = await repos.identities.findByPrincipal(`node:${peerNodeId}`);
  if (!identity || identity.signingPublicKey === null) {
    throw new SshMachinePinRepairError(
      "peer-identity-missing",
      `peer "${peerNodeId}" has not registered its relay identity`,
      peerNodeId,
    );
  }

  // The delivered pair is the peer's REGISTERED public halves, read here and
  // nowhere else, in the relay-open's own carriage (acceptance (h)).
  const cmd: SshMachinePinRepairCommand = {
    type: "ssh_machine_pin_repair",
    peerNodeId,
    peerSigningPublicKey: identity.signingPublicKey,
    peerEncryptPublicKey: base64OfJwk(identity.publicKey),
  };

  // A online: the act sends a signed command, like relay-open. Every RPC
  // failure leaves as the named door; nothing has been audited yet, and
  // nothing will be on these paths (no audit-as-success on a refusal).
  const sender = repairDeps().sendRepair ?? sshMachinePinRepair; // the `??` is the production wiring
  let ack: { repaired: true; peerNodeId: string };
  try {
    ack = await sender(nodeId, cmd);
  } catch (err) {
    if (err instanceof SshRpcError) {
      if (err.kind === "refused" || err.kind === "malformed") {
        // The machine's own words go to the LOG (they may carry its reasons;
        // they never carry OUR key material - the node refuses by shape),
        // and the refusal the human reads names the door, not the bytes.
        logger
          .withError(err)
          .warn(`ssh machine-pin repair ${err.kind} against node ${err.nodeId}: ${err.detail ?? err.message}`);
      }
      throw new SshMachinePinRepairError(
        err.kind,
        `re-pair of "${peerNodeId}" on "${nodeId}" failed: ${err.kind}`,
        nodeId,
      );
    }
    throw err;
  }
  if (!ack.repaired || ack.peerNodeId !== peerNodeId) {
    // The ack must match the act by equality (the relay-open's byte-check
    // doctrine, applied to the repair): an ack about a different peer, or a
    // soft no in a success envelope, is a protocol violation refused loudly.
    throw new SshMachinePinRepairError("malformed", `node "${nodeId}" answered a mismatched pin-repair ack`, nodeId);
  }

  // The success half: audit ids ONLY - never key bytes, never fingerprints,
  // never the delivered pair (§10; Global Constraints).
  const event: AuditEventInput = {
    actorUserId,
    action: "node.ssh_machine_pin.repair",
    targetType: "node",
    targetId: nodeId,
    metadataJson: JSON.stringify({ nodeIdOfA: nodeId, peerNodeId }),
  };
  await audit(event);
}

/** Coded refusals for the route (the host-pin mapper's shape, one per door). */
export type SshMachinePinRepairRefusal = {
  status: 400 | 403 | 404 | 409 | 502;
  code: BackendErrorCodes;
  message: string;
};

/** Map the service's named refusal onto the HTTP shape the route renders. */
export function machinePinRepairRefusal(err: SshMachinePinRepairError): SshMachinePinRepairRefusal {
  switch (err.code) {
    case "not-owner":
      return {
        status: 403,
        code: BackendErrorCodes.SSH_OWNER_INPUT_ONLY,
        message: "Repairing trust requires the node owner, or an administrator for the server host.",
      };
    case "no-node":
    case "no-peer":
      return { status: 404, code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" };
    case "same-node":
      return { status: 400, code: BackendErrorCodes.BAD_REQUEST, message: "A machine is never its own relay peer." };
    case "peer-identity-missing":
      return {
        status: 409,
        code: BackendErrorCodes.SSH_RELAY_IDENTITY_MISSING,
        message:
          "That peer has not registered its relay identity yet. Re-enroll it, or wait for its next check-in to deliver the key.",
      };
    case "offline":
      return {
        status: 409,
        code: BackendErrorCodes.NODE_OFFLINE,
        message:
          "That machine has no live connection right now; a re-pair is delivered to it directly. Bring it online and ask again.",
      };
    case "unsupported":
      return {
        status: 409,
        code: BackendErrorCodes.NODE_OUTDATED,
        message:
          "The Subshell app on that machine is too old to repair a machine pin. Update it from its machine page.",
      };
    case "timeout":
      return {
        status: 409,
        code: BackendErrorCodes.NODE_UNREACHABLE,
        message: "That machine did not answer the re-pair in time; check its connection and ask again.",
      };
    case "refused":
    case "malformed":
      return {
        status: 502,
        code: BackendErrorCodes.SSH_NODE_REFUSED,
        message: "The machine refused the re-pair. Verify the peer's registered key out of band before asking again.",
      };
  }
}
