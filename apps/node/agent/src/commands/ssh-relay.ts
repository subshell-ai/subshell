import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { open as mcpOpen, seal as mcpSeal } from "@internal/mcp-core";
import { buildSshKnownHostsPath, enforceMode } from "@internal/pane-runtime";
import {
  bytesOfJwk,
  isSshKnownHostsPinLine,
  type RelayFrame,
  SSH_RELAY_LIFETIME_MS,
  SSH_RELAY_MAX_PER_NODE,
  type SshRelayOpenCommand,
} from "@internal/subshell-protocol";
import { loadOrCreateIdentity } from "../identity.js";
import { log } from "../log.js";
import { MachinePinStore } from "../machine-pin-store.js";
import { type AgentScheme, probeAgentScheme } from "../relay-agent-scheme.js";
import { liveAgentSocketPath, requestLiveAgent } from "../relay-agent-socket.js";
import { startAgentProxy } from "../relay-proxy.js";
import { startRelayResponder } from "../relay-responder.js";
import { decodePeerEncryptionJwk } from "./ssh-shared.js";

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
 * THE TASK-8 WIRING (landed): the `ssh_relay_open` grammar carries the pane
 * (`cmd.paneId`, acceptance (b)), so {@link openBRelaySession} takes it from
 * the command it serves and binds §5.2's `<dataDir>/ssh/<paneId>/agent.sock`;
 * the executor arms live in `ssh-relay-exec.ts`, registered on the dispatch
 * switch, and the pump they hand the branches is the daemon's
 * deliver-or-throw `relay-send.ts` (acceptance (c)).
 */

/** One local owner of a relay session's inbound frames (a B proxy, or Task 7's A responder). */
export interface RelaySessionHandler {
  /** Deliver one grammar-parsed inbound frame routed to this session's ref. */
  onRelayFrame(frame: RelayFrame): void;
  /** End the session with §5.6's named reason (the `ssh_relay_close` word, or a local cut). */
  close(reason: string): void;
}

/**
 * How long a close of a ref this machine never owned is remembered. The race
 * it bounds (fix round T8 MAJOR 2): the A branch acks `pending: true` and its
 * detached open probes worst-case ~20 s (two 10 s agent round trips), so the
 * plane's `ssh_relay_close` can land while the open is still in flight - and
 * the open would then REGISTER a responder nothing will ever close, because
 * the plane already dropped the ref. A few multiples of the session lifetime
 * covers command delivery plus the probe with room; the entry is a marker,
 * not a resource, and it EXPIRES (nothing here grows unbounded).
 */
export const RELAY_CLOSE_TOMBSTONE_MS = 2 * SSH_RELAY_LIFETIME_MS;

/**
 * The per-daemon map from routing ref to its local owner. ONE instance lives
 * for the daemon's life (relay sessions outlive a link reconnect - the plane
 * re-pumps frames on the fresh socket), and {@link
 * RelaySessions.onInboundRelayFrame} is THE inbound relay dispatch every role
 * shares (Task 7). Frames for an unknown ref are dropped with a log line: a
 * stale ref (session already closed around the plane's own cut) is routine,
 * and the refusal the plane deserves is Task 8's broker's, not this map's.
 *
 * Two refusals beyond ownership, both for the openers' cleanup paths (the
 * executors' try/catch around {@link register} releases whatever they just
 * bound on EITHER refusal shape):
 * - the {@link SSH_RELAY_MAX_PER_NODE} cap THROWS a named refusal (the
 *   machine saying no to a miscounting broker);
 * - a ref closed while unowned is TOMBSTONED for {@link
 *   RELAY_CLOSE_TOMBSTONE_MS}, and {@link register} answers the dup-path
 *   false for it (the plane's cut beat a late open; the late open must not
 *   own a dead ref).
 */
export class RelaySessions {
  #byRef = new Map<string, RelaySessionHandler>();
  /** Ref closed while unowned -> expiry in ms. TTL-bounded, swept at every touch. */
  #closedRefs = new Map<string, number>();
  #say: (line: string) => void;
  #now: () => number;
  #tombstoneMs: number;

  constructor(logLine?: (line: string) => void, opts: { nowMs?: () => number; tombstoneMs?: number } = {}) {
    this.#say = logLine ?? ((line: string): void => log(line));
    this.#now = opts.nowMs ?? Date.now;
    this.#tombstoneMs = opts.tombstoneMs ?? RELAY_CLOSE_TOMBSTONE_MS;
  }

  /** Sessions currently owned (census/test surface). */
  get size(): number {
    return this.#byRef.size;
  }

  /**
   * Take ownership of a ref. False when the ref is ALREADY owned, or when it
   * carries a close tombstone (the plane closed this ref before the open
   * landed; {@link isTombstoned} lets the refused opener name which) - two
   * live sessions on one routing ref is a broker bug, and the second opener's
   * resources belong to ITSELF to release (its caller sees the false).
   * Throws a named refusal when this machine is already holding
   * {@link SSH_RELAY_MAX_PER_NODE} sessions and `ref` is NEW: the plane's
   * broker enforces the same cap authoritatively at open, and this is the
   * node refusing to hold a 9th proxy socket off a miscounting broker
   * (defense-in-depth, Task 8 (g)). The throw path and the dup-ref false
   * path are deliberately different: an owned ref is a routing collision
   * the CALLER unwinds, a full registry is the machine saying no. EITHER
   * way, an opener that already bound a resource must release it on both
   * shapes (fix round T8 MAJOR 1: the throw path once bypassed that).
   */
  register(ref: string, handler: RelaySessionHandler): boolean {
    this.#sweepTombstones();
    if (this.#byRef.has(ref)) return false;
    if (this.#closedRefs.has(ref)) return false;
    if (this.#byRef.size >= SSH_RELAY_MAX_PER_NODE) {
      throw new Error(
        `relay registry full: ${this.#byRef.size} live sessions on this machine (max ${SSH_RELAY_MAX_PER_NODE})`,
      );
    }
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
   * Whether a close of this ref is currently remembered while the ref is
   * unowned: the refused opener's discriminator between "already owned" and
   * "the plane already closed it" (fix round T8 MAJOR 2).
   */
  isTombstoned(ref: string): boolean {
    this.#sweepTombstones();
    return this.#closedRefs.has(ref);
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
   * an unknown ref - and an unknown ref is not merely ignored: the close is
   * TOMBSTONED for {@link RELAY_CLOSE_TOMBSTONE_MS}, so a detached open that
   * succeeds after the plane already cut can no longer own the ref (fix
   * round T8 MAJOR 2). A close of an OWNED ref takes the normal path and
   * tombstones nothing.
   */
  close(ref: string, reason: string): boolean {
    this.#sweepTombstones();
    const handler = this.#byRef.get(ref);
    if (!handler) {
      this.#closedRefs.set(ref, this.#now() + this.#tombstoneMs);
      this.#say(`relay close for ${ref} (${reason}): no local session; remembering the close against late opens`);
      return false;
    }
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

  /**
   * Drop every expired tombstone. Called at BOTH mutating touches (register
   * and close), so the set is TTL-window-bounded rather than a ledger: a
   * burst of closes for unknown refs ages out on the next touch and nothing
   * is ever remembered past {@link RELAY_CLOSE_TOMBSTONE_MS}.
   */
  #sweepTombstones(): void {
    const now = this.#now();
    for (const [ref, expiresAt] of this.#closedRefs) {
      if (expiresAt <= now) this.#closedRefs.delete(ref);
    }
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
  /** The pane whose ssh connects through the socket: the command's `paneId` (grammar (b)). */
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
 * Open the B side of a brokered relay pairing: enforce §4.4's machine pin on
 * A (first pairing pins both halves, a moved pin is a hard block), write the
 * destination's pinned host-key line to the pane's 0600 known_hosts file
 * (Task 12, §9 - the trust source the relay-mode config names), then bind
 * the pane's agent proxy socket and register its ref. Throws a named refusal
 * (the dispatch wrapper turns it into `ok:false`) on: role other than B, an
 * unusable peer key, a MOVED pin (naming the peer and §4.5's re-pair), a
 * malformed host pin (never a second trust entry), a ref already owned, a
 * ref the plane already closed (tombstoned), or the node-side registry cap -
 * and EVERY refusal releases the proxy this call just bound (fix round T8
 * MAJOR 1: a thrown cap refusal once bypassed that release). Resolves with
 * the composed socket path - the value the launch's scoped `SSH_AUTH_SOCK`
 * must match byte for byte (§5.2).
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

  // The destination's pinned host-key line, written to the pane's 0600
  // known_hosts file BEFORE the proxy binds (Task 12, spec 2026-10-08 §9):
  // the pane's `ssh -F` reads the relay-mode config, whose one
  // UserKnownHostsFile names this exact path. The line is verbatim from the
  // signed command; the shape is re-checked HERE because this is the last
  // station before a trust file a live ssh consults - a smuggled newline
  // would be a second, plane-authored entry, and `yes` would then block on
  // the wrong key. The path is this machine's OWN derivation
  // ({@link buildSshKnownHostsPath}(dataDir, paneId)), never a name taken
  // from the wire, so a hostile plane cannot point the write outside the
  // per-session dir that leaves with the pane. Refusal throws (dispatch
  // answers ok:false); nothing was bound yet, so there is no resource to
  // release on this path.
  if (!isSshKnownHostsPinLine(cmd.hostPin)) {
    throw new Error("relay open refused: the delivered host pin is not one known_hosts line");
  }
  const hostPinPath = buildSshKnownHostsPath(args.dataDir, args.paneId);
  {
    const dir = dirname(hostPinPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceMode(dir, 0o700);
    await writeFile(hostPinPath, `${cmd.hostPin}\n`, { mode: 0o600 });
    await enforceMode(hostPinPath, 0o600); // umask cannot leak bits past this
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

  try {
    if (
      !args.relay.register(cmd.ref, {
        onRelayFrame: (f) => proxy.deliverInboundRelayFrame(f),
        close: () => proxy.close(),
      })
    ) {
      throw new Error(
        args.relay.isTombstoned(cmd.ref)
          ? "relay open refused: routing ref already closed by the plane (late open dropped)"
          : "relay open refused: routing ref already owned by a live session",
      );
    }
  } catch (err) {
    // EVERY refused register releases the just-bound proxy: the dup/tombstone
    // false path as before, and the THROWN cap refusal too - a refused open
    // must never leave a listening fd and a socket name behind (fix round T8
    // MAJOR 1; proxy.close() is idempotent).
    proxy.close();
    throw err;
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
 * unusable peer key, a MOVED pin, a ref already owned, a ref the plane
 * already closed (tombstoned - the race this branch's detached open makes
 * real, fix round T8 MAJOR 2), or the node-side registry cap - and EVERY
 * refusal closes the responder it just started. A probe failure is
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

  try {
    if (
      !args.relay.register(cmd.ref, {
        onRelayFrame: (f) => responder.deliverInboundRelayFrame(f),
        close: (reason) => responder.close(reason),
      })
    ) {
      throw new Error(
        args.relay.isTombstoned(cmd.ref)
          ? "relay open refused: routing ref already closed by the plane (late open dropped)"
          : "relay open refused: routing ref already owned by a live session",
      );
    }
  } catch (err) {
    // Symmetric with the B branch (fix round T8 MAJOR 1): the dup false path
    // closed the responder before, and the THROWN cap refusal closes it too.
    // The A responder holds no fd, but a refused open must never leave one
    // alive and unregistered to classify bytes forever.
    responder.close();
    throw err;
  }
  return { relayId: cmd.relayId };
}
