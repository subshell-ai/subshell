import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  base64UrlNoPad,
  bytesOfJwk,
  newNonce,
  openRelayEnvelope,
  type RelayFrame,
  type RelayOpenFn,
  type RelaySealFn,
  SeqGate,
  SSH_RELAY_FRAME_MAX_BYTES,
  sealRelayEnvelope,
  verifyRelayEnvelope,
} from "@internal/subshell-protocol";
import { log } from "./log.js";

/**
 * A-side responder of the sealed agent relay (spec 2026-10-08 §5.4/§5.6): the
 * key home's gate. One inbound B2A relay frame carries one ssh-agent request
 * sealed from B; this module opens it with A's own encryption key, verifies
 * origin against B's PINNED signing key with the full Task-5 caller checklist
 * (frame-bound open, structurally bound relaySessionId / nB / nA, per-session
 * {@link SeqGate}), default-denies the agent method, enforces the grant's
 * fingerprint set against A's LIVE agent socket, and seals+signs the (possibly
 * filtered or refused) agent answer back as an A2B frame.
 *
 * The two rules of §5.4, in the order they run:
 *
 * 1. **Method allow-list, default-deny.** Exactly the two request types SSH
 *    publickey auth uses are forwarded, matched by numeric type byte on the
 *    wire; every other type (identity mutations, LOCK/UNLOCK, EXTENSION, the
 *    SSH1-era range, anything unknown) is refused WITHOUT touching A's agent.
 *    A granted window therefore cannot mutate or lock A's agent against its
 *    other panes, by default-deny rather than a name list that could miss a
 *    code.
 * 2. **Identity scoping.** The IDENTITIES_ANSWER is rebuilt with only the
 *    entries whose `SHA256:` fingerprint is in the grant's selected set, and a
 *    SIGN_REQUEST whose key blob hashes outside the set is refused before it
 *    is ever forwarded. A grant naming no fingerprint serves nothing.
 *
 * **Agent-only (§3 item 4):** the only path to a key is A's running agent
 * socket (`SSH_AUTH_SOCK`, the connecting account's own, the same
 * absolute-path rule `ssh-resolve.ts` established for the launch side). No
 * private key file is opened here, and nothing about key material is ever
 * logged.
 *
 * Refusal semantics mirror Task 6's proxy: an unopenable envelope is
 * plane-crafted noise and costs a log line (§5.6 first line: the plane holds
 * A's public key and can seal at will); an envelope that opens but fails
 * verification against the pin is a FORGERY and is refused with NO reply sent
 * (answering a forgery would hand the attacker a signature oracle and spend a
 * real seq against B's stream); a SeqGate refusal is refused silently-ish,
 * never punished, because the plane routes and can resend anything. A refused
 * REQUEST still gets the session's normal answer only in the agent layer:
 * disallowed or out-of-scope agent requests are answered with
 * `SSH2_AGENT_FAILURE` (B's ssh sees a clean "agent refused", never a hang),
 * while refused FRAMES (origin/replay) never produce any A2B at all.
 *
 * Nonce protocol (§5.6, A's side of the mirror): A mints `nA` once at session
 * start and carries it in every A2B alongside the recorded `nB`. B carries
 * `nB` in every request, so `nB` is recorded from the first verified request
 * and bound thereafter; B cannot carry `nA` until A's first reply reaches it,
 * and B's proxy never seals a second request before that reply lands
 * (Task 6's single-outstanding FIFO), so `nA` is unbound only for the session's
 * first verified request and hard-bound from the second onward.
 *
 * seal/open are INJECTED exactly as at the B side: the protocol package cannot
 * import mcp-core; the caller (commands/ssh-relay.ts, production glue) passes
 * mcp-core's pair straight through.
 */

/* ------------------------------------------------------------------ */
/* the ssh-agent wire (OpenSSH `agent-proto.h` values)                 */
/* ------------------------------------------------------------------ */

/**
 * `SSH2_AGENTC_REQUEST_IDENTITIES` - ask for the public-key list. The value
 * is from OpenSSH's `agent-proto.h` (NOT the RFC 9987 renumbering, where this
 * is 11: the wire and the real agent are OpenSSH, and the real-agent e2e is
 * the arbiter). One of the TWO forwarded request types.
 */
export const SSH2_AGENTC_REQUEST_IDENTITIES = 13;

/**
 * `SSH2_AGENTC_SIGN_REQUEST` - sign with a named blob. The value is from
 * OpenSSH's `agent-proto.h` (RFC 9987 calls this 13 - not this wire). One of
 * the TWO forwarded request types.
 */
export const SSH2_AGENTC_SIGN_REQUEST = 15;

/** `SSH2_AGENT_IDENTITIES_ANSWER` (agent-proto.h): the roster reply this module filters. */
export const SSH2_AGENT_IDENTITIES_ANSWER = 2;

/** `SSH2_AGENT_SIGN_RESPONSE` (agent-proto.h): the signature reply, forwarded verbatim (it is opaque). */
export const SSH2_AGENT_SIGN_RESPONSE = 14;

/** `SSH2_AGENT_FAILURE` (agent-proto.h): the uniform answer to any refused request. */
export const SSH2_AGENT_FAILURE = 5;

/** One agent message's maximum payload: the relay frame cap (§5.1: cap is law). */
const MAX_AGENT_MESSAGE_BYTES = SSH_RELAY_FRAME_MAX_BYTES;

/** Local I/O budget for one round trip to A's agent (a local Unix socket call; ssh's own is unbounded, ours is not). */
const AGENT_REQUEST_TIMEOUT_MS = 10_000;

/** The single-byte refusal every refused request is answered with. */
const FAILURE = Buffer.from([SSH2_AGENT_FAILURE]);

/* ------------------------------------------------------------------ */
/* agent-wire framing + parsing (4-byte BE length + payload, shared    */
/* shape with the B proxy; the TYPE parsing is A-only per §5.4)        */
/* ------------------------------------------------------------------ */

/** Frame one agent message for the wire: 4-byte big-endian length, then the payload. */
function framing(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** A cursor over an agent payload; every read past the end throws (never a silent partial parse). */
class ByteReader {
  #buf: Buffer;
  #off = 0;

  constructor(buf: Buffer) {
    this.#buf = buf;
  }

  u32(): number {
    if (this.#off + 4 > this.#buf.length) throw new Error("agent wire: truncated uint32");
    const v = this.#buf.readUInt32BE(this.#off);
    this.#off += 4;
    return v;
  }

  bytes(n: number): Buffer {
    if (n > this.#buf.length - this.#off) throw new Error("agent wire: truncated byte run");
    const v = this.#buf.subarray(this.#off, this.#off + n);
    this.#off += n;
    return v;
  }

  /** An SSH string: uint32 length + bytes. */
  string(): Buffer {
    return this.bytes(this.u32());
  }

  done(): boolean {
    return this.#off === this.#buf.length;
  }
}

/** Serialize an SSH string for the rebuilt answer: uint32 length + bytes. */
function sshString(bytes: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([header, bytes]);
}

/**
 * The OpenSSH display fingerprint of one agent key blob: SHA-256 over the
 * RAW SSH wire encoding (the agent-answer blob bytes), spelled `SHA256:` +
 * base64url without padding - the same scheme `fingerprintJwk` established
 * (§4.5: "Agent keys hash their agent wire encoding"; §5.4), which is also
 * the only spelling the grant grammar's `GRANT_FINGERPRINT_RE` accepts.
 */
export function fingerprintAgentBlob(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64url")}`;
}

/**
 * Rebuild an IDENTITIES_ANSWER keeping ONLY the entries whose blob
 * fingerprints into `allowed`; fixes the count; kept entries ride byte-
 * identically. Throws on a malformed answer (type byte, declared entries the
 * buffer does not carry, trailing bytes) - an unparseable answer is refused
 * as a failure, NEVER forwarded unfiltered, because a partial parse of the
 * roster is exactly what §5.4 exists to prevent.
 */
export function filterIdentitiesAnswer(answer: Buffer, allowed: ReadonlySet<string>): Buffer {
  if (answer.length < 5 || answer[0] !== SSH2_AGENT_IDENTITIES_ANSWER) {
    throw new Error("relay responder: expected an SSH2_AGENT_IDENTITIES_ANSWER");
  }
  const reader = new ByteReader(answer.subarray(1));
  const count = reader.u32();
  const kept: Buffer[] = []; // one item per KEPT ENTRY (both fields pre-concatenated, so the rebuilt count is the entry count)
  for (let i = 0; i < count; i += 1) {
    const blob = reader.string();
    const comment = reader.string();
    if (allowed.has(fingerprintAgentBlob(blob))) kept.push(Buffer.concat([sshString(blob), sshString(comment)]));
  }
  if (!reader.done()) throw new Error("relay responder: IDENTITIES_ANSWER carries trailing bytes");
  return Buffer.concat([Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]), sshStringCount(kept.length), ...kept]);
}

/** The count field of a rebuilt answer (an unframed uint32, unlike an SSH string). */
function sshStringCount(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/**
 * Split a SIGN_REQUEST into its key blob (the parse throws on anything short
 * of the full grammar: string blob + uint32 flags + nothing else). The flags
 * ride through to the agent unexamined: §5.4 scopes by BLOB, not by flag.
 */
export function parseSignRequest(payload: Buffer): { keyBlob: Buffer; flags: number } {
  const reader = new ByteReader(payload.subarray(1));
  const keyBlob = reader.string();
  const flags = reader.u32();
  if (keyBlob.length === 0) throw new Error("relay responder: SIGN_REQUEST names an empty key blob");
  if (!reader.done()) throw new Error("relay responder: SIGN_REQUEST carries trailing bytes");
  return { keyBlob, flags };
}

/* ------------------------------------------------------------------ */
/* A's live agent socket                                               */
/* ------------------------------------------------------------------ */

/**
 * The connecting account's live agent socket: an absolute `SSH_AUTH_SOCK`,
 * else null - the same trust rule `ssh-resolve.ts` runs for the launch side
 * ("the env sock is trusted because it is the connecting account's own
 * setup"). A null answer is the honest no-agent case: the responder refuses
 * with SSH2_AGENT_FAILURE and never reads a key file (agent-only, §5.4).
 */
export function liveAgentSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const sock = env.SSH_AUTH_SOCK;
  return typeof sock === "string" && sock.startsWith("/") && sock.length > 1 ? sock : null;
}

/**
 * One request/response round trip to A's agent over the Unix socket:
 * connect, write one framed message, read one framed answer, close. Each
 * request rides its own connection (ssh's agent protocol permits it; no
 * session state lives on the socket). Rejects on connect failure, timeout,
 * an empty or over-cap answer, or a close before a complete answer.
 */
function requestLiveAgent(socketPath: string, payload: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let conn: Socket;
    try {
      conn = createConnection({ path: socketPath });
    } catch (err) {
      reject(new Error(`relay responder: cannot reach the agent socket: ${String(err)}`));
      return;
    }
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      reject(new Error(`relay responder: ${why}`));
    };
    const timer = setTimeout(() => fail("agent request timed out"), AGENT_REQUEST_TIMEOUT_MS);
    conn.on("error", (err: Error) => fail(`agent socket error: ${err.message}`));
    conn.on("connect", () => {
      conn.write(framing(payload));
    });
    conn.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (len === 0 || len > MAX_AGENT_MESSAGE_BYTES) {
        fail(`agent answer length ${len} is empty or over the cap`);
        return;
      }
      if (buffer.length < 4 + len) return;
      const answer = Buffer.from(buffer.subarray(4, 4 + len));
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* the destroy below handles it */
      }
      conn.destroy();
      resolve(answer);
    });
    conn.on("close", () => fail("the agent socket closed before a complete answer"));
  });
}

/* ------------------------------------------------------------------ */
/* the responder                                                       */
/* ------------------------------------------------------------------ */

/** Inputs to {@link startRelayResponder}: session facts, B's pins, A's identity, the pump, the seams. */
export interface RelayResponderArgs {
  /** The relay-session id the plane minted (§5.6: signed into every envelope). */
  relayId: string;
  /** The opaque routing ref this session's frames ride (also the registry key). */
  ref: string;
  /** This machine's node id: the open-as principal `node:<selfNodeId>`. */
  selfNodeId: string;
  /** B's node id: the seal-to principal `node:<peerNodeId>` and the pinned-key holder. */
  peerNodeId: string;
  /** B's PINNED ES256 signing public JWK (JSON string) - the origin key. */
  peerSigningJwk: string;
  /** B's PINNED ECDH-ES encryption public JWK (JSON string) - the seal-to key. */
  peerEncryptionJwk: string;
  /** A's own encryption keypair (both JWK JSON strings) - opens B's requests. */
  ownEncryptionPublicJwk: string;
  ownEncryptionPrivateJwk: string;
  /** A's own ES256 signing PRIVATE JWK - signs every A2B reply. */
  ownSigningPrivateJwk: string;
  /** The grant's selected fingerprints (§5.4); empty names nothing, serves nothing. */
  fingerprints: readonly string[];
  /** The sealing primitive - mcp-core's `seal` in production (injected, Task-5 doctrine). */
  seal: RelaySealFn;
  /** The opening primitive - mcp-core's `open`. */
  open: RelayOpenFn;
  /**
   * Hand one sealed A2B frame to the link pump (the daemon's `send`, via the
   * ctx seam). DELIVER-OR-THROW (the Task-6 contract, restated for A): a
   * dropped send must THROW here. A throw is NON-DELIVERY: no seq is
   * consumed, and B's proxy (still holding its outstanding slot) stalls until
   * the relay's external teardown - Task 8's broker closes the session on
   * its timers.
   */
  sendRelayFrame(frame: RelayFrame): void;
  /**
   * Resolve A's live agent socket per request (default {@link
   * liveAgentSocketPath}). A test seam and the operator override land here;
   * returning null is the honest no-agent case.
   */
  resolveAgentSocket?: () => string | null;
  /** Line sink; defaults to the agent logger. Never receives keys, fingerprints, nonces, or agent bytes. */
  log?: (line: string) => void;
}

/** The running responder: the two lifecycle verbs the registry adapter uses. */
export interface RelayResponderHandle {
  /**
   * Feed one INBOUND relay frame parsed off the link to this session. Only
   * B2A frames for this session's ref are honored; anything else is dropped
   * with a log line (defense in depth - the registry already routed by ref).
   * Never throws: a refused frame is a refusal, not a crash.
   */
  deliverInboundRelayFrame(frame: RelayFrame): void;
  /** End the session (§5.6's named close word from the registry, or a local cut). Idempotent. */
  close(reason?: string): void;
}

/**
 * Start the A-side responder for ONE brokered session: validate B's pins
 * (deep public-only P-256 via {@link bytesOfJwk}, the same gate the B proxy
 * runs), mint A's session nonce, and return the handler that
 * `commands/ssh-relay.ts` registers into {@link RelaySessions}. Throws a
 * named refusal when either pinned half is not usable public material.
 */
export function startRelayResponder(args: RelayResponderArgs): RelayResponderHandle {
  const say = args.log ?? ((line: string): void => log(line));

  // Pin sanity BEFORE anything binds (the B side's MINOR-3 order): bytesOfJwk
  // parses the string itself, so junk, private material, and a foreign curve
  // all land in the guard and surface as the named refusal. Parsing once
  // AFTER the guard keeps the per-frame verify free of JSON work.
  try {
    bytesOfJwk(args.peerSigningJwk);
    bytesOfJwk(args.peerEncryptionJwk);
  } catch (err) {
    throw new Error(`relay responder: pinned peer key rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  const peerSigning = JSON.parse(args.peerSigningJwk) as JsonWebKey;
  const ownSigningPrivate = JSON.parse(args.ownSigningPrivateJwk) as JsonWebKey;
  const ownEncryption = {
    principalId: `node:${args.selfNodeId}`,
    publicJwk: args.ownEncryptionPublicJwk,
    privateJwk: args.ownEncryptionPrivateJwk,
  };
  const recipient = { principalId: `node:${args.peerNodeId}`, publicJwk: args.peerEncryptionJwk };
  const allowed = new Set(args.fingerprints);
  const resolveAgent = args.resolveAgentSocket ?? liveAgentSocketPath;

  // Session state (§5.6): A's nonce is minted once and every A2B carries it;
  // B's is recorded from the first verified request. `nASeenBinding` marks
  // that the first verified request has passed, from which point every
  // inbound message MUST carry A's nonce (B learns it from A's first reply,
  // and B's single-outstanding FIFO means B's next request was sealed after
  // that reply landed - a request without it is a replay or a forgery).
  const nA = newNonce();
  let nB: string | undefined;
  let bindNA = false;
  const gate = new SeqGate();
  let signedSeq = 0;
  let transportSeq = 0;
  let closed = false;

  /** The agent-layer decision for one decoded request: the payload to answer B with. */
  const respondToAgent = async (request: Buffer): Promise<Buffer> => {
    if (request.length === 0) return FAILURE; // no type byte: nothing allow-listed, nothing forwarded
    const type = request[0];
    const agentPath = resolveAgent();
    if (type !== SSH2_AGENTC_REQUEST_IDENTITIES && type !== SSH2_AGENTC_SIGN_REQUEST) {
      // §5.4's default-deny: by the REFUSED set's behavior, not a lookup. Log the
      // numeric type (not a secret) so the operator can see what B asked for.
      say(`relay session ${args.ref}: refused disallowed agent request type ${type}; not forwarded`);
      return FAILURE;
    }
    if (type === SSH2_AGENTC_SIGN_REQUEST) {
      let keyBlob: Buffer;
      try {
        ({ keyBlob } = parseSignRequest(request));
      } catch {
        say(`relay session ${args.ref}: refused a malformed SIGN_REQUEST; not forwarded`);
        return FAILURE;
      }
      // §5.4's signing gate: checked HERE, before anything touches the agent.
      if (!allowed.has(fingerprintAgentBlob(keyBlob))) {
        say(`relay session ${args.ref}: refused a SIGN_REQUEST outside the grant set; not forwarded`);
        return FAILURE;
      }
      if (agentPath === null) {
        say(`relay session ${args.ref}: no live agent socket (SSH_AUTH_SOCK unset): refusing the request`);
        return FAILURE;
      }
      let response: Buffer;
      try {
        response = await requestLiveAgent(agentPath, request);
      } catch (err) {
        say(`relay session ${args.ref}: the agent request failed: ${String(err)}`);
        return FAILURE;
      }
      // The signature is opaque and the blob was already scoped, but the
      // response TYPE still gates: only SIGN_RESPONSE and the agent's own
      // FAILURE ride onward; anything unexpected becomes a failure.
      if (response.length < 1 || (response[0] !== SSH2_AGENT_SIGN_RESPONSE && response[0] !== SSH2_AGENT_FAILURE)) {
        say(`relay session ${args.ref}: the agent answered a sign request with an unexpected type; refusing`);
        return FAILURE;
      }
      return response;
    }
    // SSH2_AGENTC_REQUEST_IDENTITIES: the roster goes to the agent, comes
    // back, and is FILTERED here - the grant set is enforced at A, the only
    // machine that can see A's whole roster.
    if (agentPath === null) {
      say(`relay session ${args.ref}: no live agent socket (SSH_AUTH_SOCK unset): refusing the request`);
      return FAILURE;
    }
    let answer: Buffer;
    try {
      answer = await requestLiveAgent(agentPath, request);
    } catch (err) {
      say(`relay session ${args.ref}: the agent request failed: ${String(err)}`);
      return FAILURE;
    }
    if (answer.length < 1) return FAILURE;
    if (answer[0] === SSH2_AGENT_FAILURE) return FAILURE; // A's agent itself refused: pass the refusal
    if (answer[0] !== SSH2_AGENT_IDENTITIES_ANSWER) {
      say(`relay session ${args.ref}: the agent answered identities with an unexpected type; refusing`);
      return FAILURE;
    }
    try {
      return filterIdentitiesAnswer(answer, allowed);
    } catch {
      // An unparseable roster NEVER rides on: partial parsing is how an
      // ungranted identity could leak. The pane sees a clean failure.
      say(`relay session ${args.ref}: the agent's IDENTITIES_ANSWER did not parse; refusing it`);
      return FAILURE;
    }
  };

  /** The full inbound pipeline for one frame: open, verify, gate, answer. */
  const handleFrame = async (frame: RelayFrame): Promise<void> => {
    if (closed) return;
    let opened;
    try {
      // Checklist step 1: the FRAME's own routing facts bind the wrapper
      // (M-1) - a relayed blob addressed through another ref or direction
      // never reaches a key.
      opened = await openRelayEnvelope({
        blob: frame.blob,
        own: ownEncryption,
        open: args.open,
        expect: { ref: frame.ref, direction: frame.direction },
      });
    } catch {
      // Unopenable noise from the routing plane (which holds A's public key
      // and can craft seals all by itself, §5.6). Cost it a log line.
      say(`relay session ${args.ref}: refused an inbound frame (envelope did not open)`);
      return;
    }
    let message;
    try {
      // Checklist steps 2+3+4 in one call (I-1): origin against B's PINNED
      // signing key, this session's relayId, and the nonces this endpoint
      // holds. An openable wrapper with a foreign signature or another
      // session's facts is a FORGERY, not noise: it is refused and NOTHING
      // is sent back - answering a forgery would sign real A2B envelopes
      // against attacker-chosen state.
      message = await verifyRelayEnvelope({
        jws: opened.jws,
        publicJwk: peerSigning,
        expect: {
          routingRef: args.ref,
          direction: "B2A",
          seq: opened.seq,
          relaySessionId: args.relayId,
          ...(nB === undefined ? {} : { nB }),
          ...(bindNA ? { nA } : {}),
        },
      });
    } catch {
      say(`relay session ${args.ref}: refused a forgery (origin/binding verification failed); nothing sent`);
      return;
    }
    // §5.6's nonce discipline, A's side: B carries nB in EVERY request, and
    // carries nA from the first request sealed after A's first reply landed.
    // A request before the flip that already carries nA cannot be genuine
    // (A's nA has not been delivered), and one after the flip without it is
    // refused by the binding itself.
    if (message.nB === undefined || (!bindNA && message.nA !== undefined)) {
      say(`relay session ${args.ref}: refused a request with a malformed nonce pair; nothing sent`);
      return;
    }
    if (!gate.accept("B2A", message.seq)) {
      // The plane routes - and can resend - everything (§5.6). A resend is
      // refused, not punished: no agent traffic, no reply, seq unconsumed.
      say(`relay session ${args.ref}: refused a replayed/rewound request (seq ${message.seq})`);
      return;
    }
    if (nB === undefined) nB = message.nB; // record B's nonce from the first verified request
    bindNA = true; // every later request must carry A's nonce back (see above)

    const request = Buffer.from(message.agentBytesB64, "base64url");
    const reply = await respondToAgent(request);
    if (closed) return;
    const replySeq = signedSeq;
    let blob: string;
    try {
      blob = await sealRelayEnvelope({
        message: {
          relaySessionId: args.relayId,
          routingRef: args.ref,
          direction: "A2B",
          seq: replySeq,
          nB: message.nB, // the SAME value the request carried, signed onward
          nA,
          agentBytesB64: base64UrlNoPad(new Uint8Array(reply)),
        },
        privateJwk: ownSigningPrivate,
        recipient,
        seal: args.seal,
      });
    } catch (err) {
      // Malformed key material or an over-cap reply: nothing was sent, so no
      // seq is consumed. B's proxy stalls on its outstanding slot until the
      // relay's external teardown (Task 8's broker closes on its timers).
      say(`relay session ${args.ref}: could not seal a reply: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      args.sendRelayFrame({ type: "relay", ref: args.ref, seq: transportSeq, direction: "A2B", blob });
    } catch (err) {
      // DELIVER-OR-THROW: a thrown pump means B never received the answer.
      // No seq is consumed (B's next request lawfully re-uses the numbers);
      // the session stalls to external teardown, the same posture as a drop.
      say(`relay session ${args.ref}: the link pump refused a reply: ${String(err)}`);
      return;
    }
    signedSeq += 1;
    transportSeq += 1;
  };

  // Frames are processed in ARRIVAL order, one chain deep: the SeqGate is
  // per-session and must never race two opens out of order (Task 6's rule).
  let deliverChain: Promise<void> = Promise.resolve();

  return {
    deliverInboundRelayFrame(frame: RelayFrame): void {
      if (closed) return;
      if (frame.ref !== args.ref || frame.direction !== "B2A") {
        // Misrouting is a registry bug, not a threat; an A2B frame is A's own
        // echo. Either way it never reaches the request path.
        say(`relay session ${args.ref}: dropped a non-B2A or foreign-ref inbound frame`);
        return;
      }
      deliverChain = deliverChain
        .then(() => handleFrame(frame))
        .catch((err: unknown) => {
          say(`relay session ${args.ref}: inbound handling failed: ${String(err)}`);
        });
    },
    close(reason?: string): void {
      if (closed) return;
      closed = true;
      say(`relay session ${args.ref}: A-side responder closed${reason ? ` (${reason})` : ""}`);
    },
  };
}
