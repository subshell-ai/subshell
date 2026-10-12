import {
  base64UrlNoPad,
  bytesOfJwk,
  newNonce,
  openRelayEnvelope,
  type RelayFrame,
  type RelayOpenFn,
  type RelaySealFn,
  SeqGate,
  sealRelayEnvelope,
  verifyRelayEnvelope,
} from "@internal/subshell-protocol";
import {
  type AgentScheme,
  filterIdentitiesAnswer,
  fingerprintAgentBlob,
  parseSignRequest,
  parseSignResponse,
  SSH2_AGENT_FAILURE,
} from "./relay-agent-scheme.js";
import { liveAgentSocketPath, requestLiveAgent } from "./relay-agent-socket.js";

/**
 * A-side responder of the sealed agent relay (spec 2026-10-08 §5.4/§5.6): the
 * key home's gate. One inbound B2A relay frame carries one ssh-agent request
 * sealed from B; this module opens it with A's own encryption key, verifies
 * origin against B's PINNED signing key with the full Task-5 caller checklist
 * (frame-bound open, structurally bound relaySessionId / nB / nA, per-session
 * {@link SeqGate}), default-denies the agent method **in the probed scheme**,
 * enforces the session's fingerprint set against A's LIVE agent socket, and
 * seals+signs the (possibly filtered or refused) agent answer back as an A2B
 * frame. The agent wire itself (numbering, parsing, scoping helpers) lives in
 * `relay-agent-scheme.ts`; the socket round trip in `relay-agent-socket.ts`.
 *
 * The three rules of §5.4, in the order they run:
 *
 * 1. **The scheme is probed, never assumed (ruling 2026-10-08).** Classic
 * (identities 13 / sign 15) and RFC 9987 / OpenSSH-10.x (identities 11 / sign
 * 13) numbering COLLIDE at byte 13: forwarding it raw as identities against a
 * 10.x agent forwards a SIGN_REQUEST unscoped, and the key home signs an
 * attacker-chosen blob. The session is therefore opened with a resolved
 * `AgentScheme` (the probe lives in `relay-agent-scheme.ts`, run by
 * `openARelaySession`); a session whose probe resolved NOTHING classifies
 * nothing and forwards nothing - every request is refused.
 * 2. **Method allow-list, default-deny in the resolved scheme.** Exactly the
 * two request types SSH publickey auth uses - the identities and sign
 * codepoints THAT scheme names - are ever forwarded; every other byte
 * (identity mutations, LOCK/UNLOCK, EXTENSION, the SSH1-era range, the OTHER
 * scheme's codes, anything unknown) dies here without touching A's agent.
 * 3. **Identity scoping BEFORE any forward.** The identities answer is
 * rebuilt with only the entries whose `SHA256:` fingerprint is in the selection;
 * a sign request is parsed, its key blob fingerprinted, and a blob outside
 * the set is refused at the responder - the bytes NEVER reach A's agent,
 * whichever codepoint the scheme treats as sign (§5.4's load-bearing rule).
 * A selected-key window therefore signs and sees only the keys the operator picked.
 *
 * **Agent-only (§3 item 4):** the only path to a key is A's running agent
 * socket (`SSH_AUTH_SOCK`, the connecting account's own, the absolute-path
 * rule `relay-agent-socket.ts` shares with `ssh-resolve.ts`). No private key
 * file is opened anywhere, and nothing about key material is ever logged.
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
 * SSH2_AGENT_FAILURE (B's ssh sees a clean "agent refused", never a hang),
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

/** The single-byte refusal every refused request is answered with (5 in both schemes). */
const FAILURE = Buffer.from([SSH2_AGENT_FAILURE]);

/* ------------------------------------------------------------------ */
/* the responder                                                       */
/* ------------------------------------------------------------------ */

/** Inputs to {@link startRelayResponder}: session facts, B's pins, A's identity, the probed scheme, the seams. */
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
  /**
   * The numbering probe resolved against A's live agent at session open
   * ({@link probeAgentScheme} in relay-agent-scheme.ts, run by
   * openARelaySession). Null means unresolved: this session classifies no
   * byte and forwards nothing, because a byte under a GUESSED scheme is the
   * CRITICAL the 2026-10-08 ruling exists to prevent.
   */
  agentScheme: AgentScheme | null;
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
   * Resolve A's live agent socket per request (default `liveAgentSocketPath`
   * from relay-agent-socket.ts). A test seam and the operator override land
   * here; returning null is the honest no-agent case. The cached scheme is
   * not re-probed mid-session: the strictly-parsed response body, not merely
   * the type byte, is what rejects a foreign-scheme answer.
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
 * `commands/ssh-relay.ts` registers into `RelaySessions`. Throws a named
 * refusal when either pinned half is not usable public material.
 */
export function startRelayResponder(args: RelayResponderArgs): RelayResponderHandle {
  const say = args.log ?? (() => {});

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
  const peerSigning = JSON.parse(args.peerSigningJwk) as Parameters<typeof verifyRelayEnvelope>[0]["publicJwk"];
  const ownSigningPrivate = JSON.parse(args.ownSigningPrivateJwk) as Parameters<
    typeof verifyRelayEnvelope
  >[0]["publicJwk"];
  const ownEncryption = {
    principalId: `node:${args.selfNodeId}`,
    publicJwk: args.ownEncryptionPublicJwk,
    privateJwk: args.ownEncryptionPrivateJwk,
  };
  const recipient = { principalId: `node:${args.peerNodeId}`, publicJwk: args.peerEncryptionJwk };
  const allowed = new Set(args.fingerprints);
  const resolveAgent = args.resolveAgentSocket ?? liveAgentSocketPath;
  const scheme = args.agentScheme; // cached at session open; NEVER re-derived per byte

  // Session state (§5.6): A's nonce is minted once and every A2B carries it;
  // B's is recorded from the first verified request. `bindNA` marks that the
  // first verified request has passed, from which point every inbound message
  // MUST carry A's nonce (B learns it from A's first reply, and B's
  // single-outstanding FIFO means B's next request was sealed after that
  // reply landed - a request without it is a replay or a forgery).
  const nA = newNonce();
  let nB: string | undefined;
  let bindNA = false;
  const gate = new SeqGate();
  let signedSeq = 0;
  let transportSeq = 0;
  let closed = false;

  /** The agent-layer decision for one decoded request: the payload to answer B with. */
  const respondToAgent = async (request: Buffer): Promise<Buffer> => {
    if (request.length === 0) {
      say(`relay session ${args.ref}: refused an agent request with no type byte; not forwarded`);
      return FAILURE;
    }
    if (scheme === null) {
      // The numbering probe resolved nothing at open: there is no safe
      // reading of ANY byte, and forwarding under a guess is exactly the
      // C-2 bug this ruling killed. Refuse, always.
      say(`relay session ${args.ref}: refused a request with no resolved agent scheme; not forwarded`);
      return FAILURE;
    }
    const type = request[0];

    if (type === scheme.sign) {
      let keyBlob: Buffer;
      try {
        ({ keyBlob } = parseSignRequest(request, scheme));
      } catch {
        say(`relay session ${args.ref}: refused a malformed SIGN_REQUEST body; not forwarded`);
        return FAILURE;
      }
      // §5.4's signing gate, BEFORE anything else touches the agent: a sign
      // whose blob is outside the grant dies here whichever codepoint the
      // probed scheme treats as sign (classic 15 or 10.x 13 - the very byte
      // the first pass forwarded raw).
      if (!allowed.has(fingerprintAgentBlob(keyBlob))) {
        say(`relay session ${args.ref}: refused a SIGN_REQUEST outside the grant set; not forwarded`);
        return FAILURE;
      }
      const agentPath = resolveAgent();
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
      // answer is still gated in the resolved scheme, by TYPE AND BODY:
      // the type bytes collide across schemes (classic's roster answer is
      // 14, which is 10.x's sign response), so only the strictly parsed
      // body - exactly one signature string - tells a signature from a
      // foreign scheme's roster. That scheme's well-formed SIGN_RESPONSE
      // and the agent's own FAILURE ride onward; anything else fails.
      if (response.length >= 1 && response[0] === SSH2_AGENT_FAILURE) return response;
      try {
        parseSignResponse(response, scheme);
      } catch {
        say(`relay session ${args.ref}: the agent's sign answer was not a well-formed SIGN_RESPONSE; refusing`);
        return FAILURE;
      }
      return response;
    }

    if (type === scheme.identities) {
      if (request.length !== 1) {
        say(`relay session ${args.ref}: refused a malformed REQUEST_IDENTITIES; not forwarded`);
        return FAILURE;
      }
      const agentPath = resolveAgent();
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
      if (answer[0] !== scheme.answer) {
        say(`relay session ${args.ref}: the agent answered identities with an unexpected type; refusing`);
        return FAILURE;
      }
      try {
        return filterIdentitiesAnswer(answer, allowed, scheme);
      } catch {
        // An unparseable roster NEVER rides on: partial parsing is how an
        // ungranted identity could leak. The pane sees a clean failure.
        say(`relay session ${args.ref}: the agent's IDENTITIES_ANSWER did not parse; refusing it`);
        return FAILURE;
      }
    }

    // §5.4's default-deny in the resolved scheme: the OTHER scheme's codes,
    // the answer/response bytes aimed at us as requests, identity mutations,
    // LOCK/UNLOCK, EXTENSION, the SSH1-era range, anything unknown. Log the
    // numeric type (not a secret) so the operator can see what B asked for.
    say(`relay session ${args.ref}: refused disallowed agent request type ${type}; not forwarded`);
    return FAILURE;
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
