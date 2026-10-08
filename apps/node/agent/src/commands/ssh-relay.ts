import { open as mcpOpen, seal as mcpSeal } from "@internal/mcp-core";
import { bytesOfJwk, type RelayFrame, type SshRelayOpenCommand } from "@internal/subshell-protocol";
import { loadOrCreateIdentity } from "../identity.js";
import { log } from "../log.js";
import { MachinePinStore } from "../machine-pin-store.js";
import { type AgentScheme, probeAgentScheme } from "../relay-agent-scheme.js";
import { liveAgentSocketPath, requestLiveAgent } from "../relay-agent-socket.js";
import { startAgentProxy } from "../relay-proxy.js";
import { startRelayResponder } from "../relay-responder.js";

/**
 * The node-side relay session registry (spec 2026-10-08 §5.1/§5.2) and the B
 * branch of the brokered pairing.
 *
 * The daemon's inbound route hands EVERY `relay` link frame to this module's
 * single dispatcher ({@link RelaySessions.onInboundRelayFrame}); the JWS
 * command path never sees one. Which local role owns a `ref` is the only
 * question routing asks: the B-side agent proxy registers itself
 * ({@link openBRelaySession}) and the A-side responder registers into the
 * SAME registry ({@link openARelaySession}); Task 8's `ssh_relay_open`
 * executor decides which branch a command drives by the command's own `role`
 * field. That is the whole seam - one dispatch, one map, both roles.
 *
 * §5.1's pairing doctrine needs the pairing itself: the plane's
 * `ssh_relay_open` command carries the relay-session id, the routing ref, both
 * node ids with roles, and the peer's registered signing + encryption keys.
 * The B branch enforces §4.4's byte-equality pin (first pairing writes the
 * pin; a pin that moved is a hard block naming the peer and §4.5's recovery,
 * never a silent overwrite) and only then binds the pane's agent socket.
 *
 * WHAT THE WIRE DOES NOT CARRY YET (handed to Task 8): the frozen
 * `ssh_relay_open` grammar names no pane. §5.2 puts the socket in the PANE's
 * ssh dir (`<dataDir>/ssh/<paneId>/agent.sock`), so {@link openBRelaySession}
 * takes the `paneId` as an explicit executor input - whoever delivers the
 * command must supply it (a grammar addition or a launch-side correlation;
 * the proxy refuses an id outside the path-composition shape either way, so
 * guessing is structurally impossible). No executor arm is registered on this
 * pass: `ssh_relay_open`/`ssh_relay_close` keep answering `unsupported` from
 * the dispatch switch until Task 8's delivery wires them.
 */

/** One local owner of a relay session's inbound frames (a B proxy, or Task 7's A responder). */
export interface RelaySessionHandler {
  /** Deliver one grammar-parsed inbound frame routed to this session's ref. */
  onRelayFrame(frame: RelayFrame): void;
  /** End the session with §5.6's named reason (the `ssh_relay_close` word, or a local cut). */
  close(reason: string): void;
}

/**
 * The per-daemon map from routing ref to its local owner. ONE instance lives
 * for the daemon's life (relay sessions outlive a link reconnect - the plane
 * re-pumps frames on the fresh socket), and {@link
 * RelaySessions.onInboundRelayFrame} is THE inbound relay dispatch every role
 * shares (Task 7). Frames for an unknown ref are dropped with a log line: a
 * stale ref (session already closed around the plane's own cut) is routine,
 * and the refusal the plane deserves is Task 8's broker's, not this map's.
 */
export class RelaySessions {
  #byRef = new Map<string, RelaySessionHandler>();
  #say: (line: string) => void;

  constructor(logLine?: (line: string) => void) {
    this.#say = logLine ?? ((line: string): void => log(line));
  }

  /** Sessions currently owned (census/test surface). */
  get size(): number {
    return this.#byRef.size;
  }

  /**
   * Take ownership of a ref. False when the ref is ALREADY owned - two live
   * sessions on one routing ref is a broker bug, and the second opener's
   * resources belong to ITSELF to release (its caller sees the false).
   */
  register(ref: string, handler: RelaySessionHandler): boolean {
    if (this.#byRef.has(ref)) return false;
    this.#byRef.set(ref, handler);
    return true;
  }

  /** Release ownership WITHOUT closing (the caller owns its own teardown). */
  unregister(ref: string): void {
    this.#byRef.delete(ref);
  }

  /** Whether this machine currently owns `ref`. */
  has(ref: string): boolean {
    return this.#byRef.has(ref);
  }

  /**
   * THE single inbound relay dispatch (the Task-7-reused seam): route one
   * parsed frame to whichever local role owns its ref. A throwing owner is
   * contained - one poisoned session cannot take the frame chain down.
   */
  onInboundRelayFrame(frame: RelayFrame): void {
    const handler = this.#byRef.get(frame.ref);
    if (!handler) {
      // Refs are opaque ids, not secrets and not paths: naming one is how the
      // operator can correlate this line with the plane's broker log.
      this.#say(`relay frame for unknown session ref ${frame.ref}: dropped`);
      return;
    }
    try {
      handler.onRelayFrame(frame);
    } catch (err) {
      this.#say(`relay session ${frame.ref}: inbound handling threw: ${String(err)}`);
    }
  }

  /**
   * Close the session named by `ref` (what Task 8's `ssh_relay_close`
   * executor will call). True when a session was owned and closed, false for
   * an unknown ref.
   */
  close(ref: string, reason: string): boolean {
    const handler = this.#byRef.get(ref);
    if (!handler) return false;
    this.#byRef.delete(ref);
    try {
      handler.close(reason);
    } catch (err) {
      this.#say(`relay session ${ref}: close threw: ${String(err)}`);
    }
    return true;
  }

  /** Close everything (daemon shutdown / a link that will never return). */
  closeAll(reason: string): void {
    for (const ref of [...this.#byRef.keys()]) this.close(ref, reason);
  }
}

/** Everything {@link openBRelaySession} needs: the daemon's seams + the command's pairing + the pane. */
export interface BRelaySessionArgs {
  /** The daemon's registry this session joins. */
  relay: RelaySessions;
  /** The node's data dir (config.dataDir). */
  dataDir: string;
  /** This machine's node id (config.nodeId) - the open-as principal. */
  selfNodeId: string;
  /** The pane whose ssh connects through the socket (see the module header's Task-8 note). */
  paneId: string;
  /** The verified `ssh_relay_open` body; its `role` MUST be "B". */
  cmd: SshRelayOpenCommand;
  /**
   * The link pump: one sealed B2A frame onto the current socket. Forwarded to
   * the proxy unchanged, so it carries the proxy's DELIVER-OR-THROW contract:
   * a dropped send must THROW here (Task-8 glue obligation), never log and
   * return - the proxy fails the request's connection on a throw rather than
   * parking a phantom reply that never comes.
   */
  sendRelayFrame(frame: RelayFrame): void;
  /** Line sink (defaults to the agent logger); never sees keys or agent bytes. */
  log?: (line: string) => void;
}

/**
 * Decode the command's base64 spelling of the peer's registered ECDH-ES public
 * key into the raw public JWK string the pin store holds (the §4.2 registration
 * spelling; the grammar's `BASE64_RE` gate already proved the outer layer).
 */
function decodePeerEncryptionJwk(b64: string): string {
  const jwk = Buffer.from(b64, "base64").toString("utf8");
  // The pin's encryption half must be a PUBLIC P-256 JWK - the same deep
  // refusal `bytesOfJwk` gives the signing half (private material, foreign
  // curve, junk all throw; the grammar's shallow `d` gate stops at top level).
  bytesOfJwk(jwk);
  return jwk;
}

/**
 * Open the B side of a brokered relay pairing: enforce §4.4's machine pin on
 * A (first pairing pins both halves, a moved pin is a hard block), then bind
 * the pane's agent proxy socket and register its ref. Throws a named refusal
 * (the dispatch wrapper turns it into `ok:false`) on: role other than B, an
 * unusable peer key, a MOVED pin (naming the peer and §4.5's re-pair), or a
 * ref already owned. Resolves with the composed socket path - the value the
 * launch's scoped `SSH_AUTH_SOCK` must match byte for byte (§5.2).
 *
 * The gate (ssh-enabled mirror) is the CALLER's first check, like every SSH
 * arm's: this function is the pairing's mechanics, not the policy.
 */
export async function openBRelaySession(args: BRelaySessionArgs): Promise<{ socketPath: string }> {
  const { cmd } = args;
  if (cmd.role !== "B") throw new Error("relay open refused: this machine is not the B side of the pairing");
  // The role says B; the pairing must ALSO name THIS machine as B (§5.4's
  // "a session naming this machine" reads both branches alike - a command
  // about someone else's pairing is refused before any pin is consulted).
  if (cmd.bNodeId !== args.selfNodeId) {
    throw new Error("relay open refused: this machine is not the connecting side named by the pairing");
  }

  // §4.4: both halves, byte-equal, in the node-side store (its own file, never
  // honoring SUBSHELL_CHANNEL_PIN - MachinePinStore's own doctrine). Every key
  // gate lands in the SAME named refusal (the raw bytesOfJwk text would reach
  // the dispatch answer otherwise): decode, deep-check, reject before any pin.
  let candidate: { signing: string; encryption: string };
  try {
    candidate = {
      signing: cmd.peerSigningPublicKey,
      encryption: decodePeerEncryptionJwk(cmd.peerEncryptPublicKey),
    };
    bytesOfJwk(candidate.signing); // deep public-only validity on the signing half too
  } catch (err) {
    throw new Error(`relay open refused: peer pin rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pins = new MachinePinStore(args.dataDir);
  const existing = pins.get(cmd.aNodeId);
  if (existing === null) {
    pins.pin(cmd.aNodeId, candidate); // first pairing: the plane-delivered keys become the pin (§4.4/§4.6's accepted window)
  } else if (pins.check(cmd.aNodeId, candidate) !== "ok") {
    // Hard block naming the peer and pointing at recovery - §4.5: re-pair is
    // an operator act; nothing here may "trust anyway".
    throw new Error(
      `relay open refused: machine pin for ${cmd.aNodeId} has MOVED (re-pair per §4.5 after out-of-band verification)`,
    );
  }

  const identity = await loadOrCreateIdentity(args.dataDir);
  const proxy = await startAgentProxy({
    dataDir: args.dataDir,
    paneId: args.paneId,
    relayId: cmd.relayId,
    ref: cmd.ref,
    peerNodeId: cmd.aNodeId,
    selfNodeId: args.selfNodeId,
    peerSigningJwk: candidate.signing,
    peerEncryptionJwk: candidate.encryption,
    ownEncryptionPublicJwk: identity.publicJwk,
    ownEncryptionPrivateJwk: identity.privateJwk,
    ownSigningPrivateJwk: identity.signingPrivateJwk,
    seal: mcpSeal,
    open: mcpOpen,
    sendRelayFrame: args.sendRelayFrame,
    ...(args.log === undefined ? {} : { log: args.log }),
  });

  if (
    !args.relay.register(cmd.ref, {
      onRelayFrame: (f) => proxy.deliverInboundRelayFrame(f),
      close: () => proxy.close(),
    })
  ) {
    proxy.close();
    throw new Error("relay open refused: routing ref already owned by a live session");
  }
  return { socketPath: proxy.socketPath };
}

/** Everything {@link openARelaySession} needs: the daemon's seams + the command's pairing. */
export interface ARelaySessionArgs {
  /** The daemon's registry this session joins. */
  relay: RelaySessions;
  /** The node's data dir (config.dataDir): holds A's identity and B's pin. */
  dataDir: string;
  /** This machine's node id (config.nodeId) - must equal `cmd.aNodeId`, the open-as principal. */
  selfNodeId: string;
  /** The verified `ssh_relay_open` body; its `role` MUST be "A" and its `aNodeId` MUST be this machine. */
  cmd: SshRelayOpenCommand;
  /**
   * The link pump: one sealed A2B frame onto the current socket. The
   * responder forwards it unchanged, so it carries the DELIVER-OR-THROW
   * contract (the Task-8 glue obligation): a dropped send must THROW, and A
   * consumes no seq for a reply that never left.
   */
  sendRelayFrame(frame: RelayFrame): void;
  /**
   * Resolve A's live agent socket; defaults to `liveAgentSocketPath` (the
   * connecting account's absolute `SSH_AUTH_SOCK`, the ssh-resolve rule).
   * Used ONCE by the open-time numbering probe and again per forwarded
   * request. The test seam for a stub agent.
   */
  resolveAgentSocket?: () => string | null;
  /** Line sink (defaults to the agent logger); never sees keys, fingerprints, or agent bytes. */
  log?: (line: string) => void;
}

/**
 * Open the A side of a brokered relay pairing: enforce §4.4's machine pin on
 * B (first pairing writes both halves, a moved pin is a hard block naming the
 * peer and §4.5's re-pair), PROBE A's live agent to resolve its numbering
 * (the ruling of 2026-10-08: classic 13/15 and OpenSSH-10.x 11/13 collide at
 * byte 13, so {@link probeAgentScheme} must name the scheme once, here, before
 * any byte is ever classified; an unresolved probe opens a session that
 * refuses everything, never one that guesses), then start
 * {@link startRelayResponder} for the command's grant (its selected
 * fingerprint set is carried by the command itself, §5.1 - the responder
 * enforces it without a REST call it cannot make) and register the ref.
 * Throws a named refusal (the dispatch wrapper turns it into `ok:false`) on:
 * role other than A, a pairing that names a different machine as A, an
 * unusable peer key, a MOVED pin, or a ref already owned. A probe failure is
 * NOT a throw: the session opens refuse-closed. Resolves with the session id
 * - nothing about the machine is in the answer, and no path exists to leak.
 *
 * The gate (ssh-enabled mirror) is the CALLER's first check, like every SSH
 * arm's: this function is the pairing's mechanics, not the policy. §5.4's
 * roster command (`ssh_agent_identities`, Task 11) is a separate signed
 * command, not this session: the responder serves ONLY brokered traffic.
 */
export async function openARelaySession(args: ARelaySessionArgs): Promise<{ relayId: string }> {
  const { cmd } = args;
  if (cmd.role !== "A") throw new Error("relay open refused: this machine is not the A side of the pairing");
  // §5.4: "a session naming this A" - the role alone is not enough when the
  // plane brokers many machines' pairings through one daemon; the pairing
  // must name THIS machine as the key home before any pin is consulted.
  if (cmd.aNodeId !== args.selfNodeId) {
    throw new Error(`relay open refused: this machine is not the key home ${cmd.aNodeId} named by the pairing`);
  }

  // §4.4: both halves, byte-equal, in the node-side store (its own file, never
  // honoring SUBSHELL_CHANNEL_PIN - MachinePinStore's own doctrine). The peer
  // here is B: A pins whoever the command names as the connecting machine.
  // Same named-refusal wrapper as the B branch.
  let candidate: { signing: string; encryption: string };
  try {
    candidate = {
      signing: cmd.peerSigningPublicKey,
      encryption: decodePeerEncryptionJwk(cmd.peerEncryptPublicKey),
    };
    bytesOfJwk(candidate.signing); // deep public-only validity on the signing half too
  } catch (err) {
    throw new Error(`relay open refused: peer pin rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pins = new MachinePinStore(args.dataDir);
  const existing = pins.get(cmd.bNodeId);
  if (existing === null) {
    pins.pin(cmd.bNodeId, candidate); // first pairing: the plane-delivered keys become the pin (§4.4/§4.6's accepted window)
  } else if (pins.check(cmd.bNodeId, candidate) !== "ok") {
    // Hard block naming the peer and pointing at recovery - §4.5: re-pair is
    // an operator act; nothing here may "trust anyway".
    throw new Error(
      `relay open refused: machine pin for ${cmd.bNodeId} has MOVED (re-pair per §4.5 after out-of-band verification)`,
    );
  }

  // The numbering probe (ruling 2026-10-08), at session open and ONCE: the
  // responder classifies every later byte only in what this resolves. No
  // socket, or an agent that answers neither candidate, is not an error to
  // throw around - it is the honest unresolved case, and an unresolved
  // session refuses every request rather than forward one under a guess.
  const say = args.log ?? ((line: string): void => log(line));
  const resolveAgent = args.resolveAgentSocket ?? liveAgentSocketPath;
  const agentSocket = resolveAgent();
  let agentScheme: AgentScheme | null = null;
  if (agentSocket !== null) {
    agentScheme = await probeAgentScheme(agentSocket, requestLiveAgent);
  }
  if (agentScheme === null) {
    say(`relay session ${cmd.ref}: agent numbering unresolved at open; every request will be refused`);
  } else {
    say(`relay session ${cmd.ref}: agent numbering resolved: ${agentScheme.name}`);
  }

  const identity = await loadOrCreateIdentity(args.dataDir);
  const responder = startRelayResponder({
    agentScheme,
    relayId: cmd.relayId,
    ref: cmd.ref,
    selfNodeId: args.selfNodeId,
    peerNodeId: cmd.bNodeId,
    peerSigningJwk: candidate.signing,
    peerEncryptionJwk: candidate.encryption,
    ownEncryptionPublicJwk: identity.publicJwk,
    ownEncryptionPrivateJwk: identity.privateJwk,
    ownSigningPrivateJwk: identity.signingPrivateJwk,
    fingerprints: cmd.fingerprints,
    seal: mcpSeal,
    open: mcpOpen,
    sendRelayFrame: args.sendRelayFrame,
    resolveAgentSocket: resolveAgent,
    ...(args.log === undefined ? {} : { log: args.log }),
  });

  if (
    !args.relay.register(cmd.ref, {
      onRelayFrame: (f) => responder.deliverInboundRelayFrame(f),
      close: (reason) => responder.close(reason),
    })
  ) {
    responder.close();
    throw new Error("relay open refused: routing ref already owned by a live session");
  }
  return { relayId: cmd.relayId };
}
