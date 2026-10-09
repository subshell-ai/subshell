import { BackendErrorCodes } from "@internal/backend-errors";
import type { SshMachinePinRepairCommand } from "@internal/subshell-protocol";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { type AuditEventInput, audit } from "@/services/audit.js";
import { SshRpcError, sshMachinePinRepair } from "@/services/nodes/ssh-rpc.js";
import { base64OfJwk } from "@/services/ssh-relay.service.js";
import { logger } from "@/utils/logger.js";

/**
 * The §4.5 machine trust re-pair (spec 2026-10-08 §4.5, Task 17): the ONE
 * sanctioned way a pinned entry changes. When a peer's machine key genuinely
 * rotated (a re-enroll or a replaced data dir, §4.2), byte-strict pairing
 * blocks the relationship permanently - the design has no "trust anyway"
 * escape. The peer's OWNER (of the machine whose store is edited) re-pairs:
 * the plane reads the PEER's CURRENT registered public pair from the
 * identities store (signing §4.2/§4.3 + encryption, the same two halves
 * §4.4 pins and the relay-open carries), sends the signed
 * `ssh_machine_pin_repair` command to A over its live link, and audits
 * `node.ssh_machine_pin.repair` naming the TWO NODE IDS ONLY.
 *
 * **The posture, in order:**
 * - OWNER, exactly: the actor must be `nodes.ownerUserId` of A (the route
 *   enforces it as the HTTP refusal; this service re-checks because a trust
 *   act's enforcement should never live only at one door - an `edit` grantee
 *   may not re-authorize a peer's key on someone else's machine, and the
 *   admin's instance-wide edit does not reach here either).
 * - A ONLINE: the act sends a signed command, like relay-open. An offline A
 *   is the named `offline` refusal, and NOTHING was written or audited -
 *   the audit lands only after A's own ack confirms the write ("fails closed
 *   if A offline: no audit-as-success").
 * - `local` never: not as A and not as the peer (no agent store to repair,
 *   and `local` has no relay identity; the LOCAL_NODE_ID guard is the cheap
 *   first read and the kind check is the general one).
 * - The delivered pair is the peer's REGISTERED identity, read from the
 *   store - never from the caller, never re-reported by A. Deep key hygiene
 *   (public-only, no `d`, importability) was enforced when those bytes were
 *   enrolled/registered, and A's handler re-validates before writing; this
 *   layer transports signed, it does not launder.
 * - No key bytes enter a log line, the audit row, or a refusal message
 *   (Global Constraints; docs/security.md §10). The metadata is exactly
 *   `{ nodeIdOfA, peerNodeId }`.
 */

/** Why a re-pair refused; each code names its own door (the route renders the copy). */
export type SshMachinePinRepairFailure =
  | "not-owner"
  | "no-node"
  | "local-node"
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

  // A first, and EXACTLY its owner (admin included not - a trust act on
  // someone else's machine is nobody else's decision).
  if (nodeId === LOCAL_NODE_ID) {
    throw new SshMachinePinRepairError(
      "local-node",
      "the control-plane host keeps no machine trust store to repair",
      nodeId,
    );
  }
  const aRow = await repos.nodes.findById(nodeId);
  if (!aRow) throw new SshMachinePinRepairError("no-node", `node "${nodeId}" has no row`, nodeId);
  if (aRow.ownerUserId !== actorUserId) {
    throw new SshMachinePinRepairError("not-owner", `node "${nodeId}" is not this actor's machine`, nodeId);
  }
  if (aRow.kind !== "agent") {
    throw new SshMachinePinRepairError(
      "local-node",
      `"${nodeId}" is not an agent machine; it has no pin store`,
      nodeId,
    );
  }
  if (peerNodeId === nodeId) {
    // A machine pinning ITSELF is a contradiction the pairing design has no
    // word for (the node refuses it too - both doors name it before a byte
    // moves).
    throw new SshMachinePinRepairError("same-node", "a machine is never its own relay peer", nodeId);
  }

  // The peer: an existing AGENT node with a complete registered identity.
  // Foreign ownership of the peer is no obstacle - the act re-delivers what
  // the peer's own enrollment registered, to a store its owner commands.
  if (peerNodeId === LOCAL_NODE_ID) {
    throw new SshMachinePinRepairError(
      "local-node",
      "the control-plane host is never a machine pin's peer",
      peerNodeId,
    );
  }
  const peerRow = await repos.nodes.findById(peerNodeId);
  if (!peerRow) throw new SshMachinePinRepairError("no-peer", `peer node "${peerNodeId}" has no row`, peerNodeId);
  if (peerRow.kind !== "agent") {
    throw new SshMachinePinRepairError("local-node", `peer "${peerNodeId}" is not an agent machine`, peerNodeId);
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
        message: "Re-pairing a machine trust pin is restricted to the machine's owner.",
      };
    case "no-node":
    case "no-peer":
      return { status: 404, code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" };
    case "local-node":
      return {
        status: 400,
        code: BackendErrorCodes.BAD_REQUEST,
        message: "Machine trust re-pairing applies to agent machines only; the control-plane host holds no such store.",
      };
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
