import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { buildSshConfigPath } from "@internal/pane-runtime";
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
 * B-side ssh-agent proxy socket (spec 2026-10-08 §5.2): the pane's `ssh`
 * connects here through its scoped `SSH_AUTH_SOCK`, and every agent request it
 * writes is shipped to A as ONE sealed relay envelope - framed on the local
 * wire (4-byte big-endian length + payload, the ssh-agent protocol), sealed by
 * the Task-5 codec to A's PINNED encryption key, signed with B's own §4.1
 * signing key, and handed to the link pump as a `relay` frame. A's replies
 * (inbound A2B frames) are opened, run through the full Task-5 caller
 * checklist - verify against A's pinned signing key, cross-check the recorded
 * session id and both nonces, then the per-session {@link SeqGate} - and the
 * returned agent bytes are written back with the same framing. Nothing that
 * fails verification reaches the socket: the pane would rather hang than
 * consume a forged reply.
 *
 * The socket lives at `<dataDir>/ssh/<paneId>/agent.sock`, mode 0600, in the
 * per-session ssh dir M1 established for the rendered config - the path is
 * derived through {@link buildSshConfigPath} itself, so the two machines'
 * byte-equal derivation and the exit sweep keep finding one tree. The proxy
 * exists only for the handshake window (§5.6); `close()` unbinds it and the
 * caller (relay close / pane teardown) drives the timing.
 *
 * Correlation: a relay frame carries no request id (the plane routes blind by
 * ref), so the proxy keeps AT MOST ONE outstanding request - later requests
 * queue locally, unsealed, until the reply lands. ssh itself serializes
 * agent requests per connection; the queue makes that true across the relay
 * too, which is what makes replies safely FIFO.
 *
 * Key handling mirrors the caller checklist in `task-5-report` verbatim: the
 * wrapper is opened with B's own encryption key and the FRAME's ref/direction
 * (`expect` required, M-1); the signature is verified against A's pinned
 * signing key with `relaySessionId`, `nB`, and (once recorded) `nA` all bound
 * into `expect` (I-1); the signed `seq` passes through the session's gate.
 * seal/open are INJECTED (the protocol package cannot import mcp-core; the
 * agent imports it directly and passes `seal`/`open` through).
 */

/** One agent message's maximum payload: the relay frame cap (§5.1: cap is law). */
const MAX_AGENT_MESSAGE_BYTES = SSH_RELAY_FRAME_MAX_BYTES;

/** Inputs to {@link startAgentProxy}: session facts, pinned keys, injected crypto, the pump. */
export interface AgentProxyArgs {
  /** The node's data dir; the pane's ssh dir hangs under `<dataDir>/ssh/<paneId>/`. */
  dataDir: string;
  /** The pane whose `ssh` connects here; the per-session ssh dir is named by it. */
  paneId: string;
  /** The relay-session id the plane minted (§5.6: signed into every envelope). */
  relayId: string;
  /** The opaque routing ref this session's frames ride (also the registry key). */
  ref: string;
  /** A's node id: the seal-to principal `node:<peerNodeId>` and the pinned-key holder. */
  peerNodeId: string;
  /** This machine's node id: the open-as principal `node:<selfNodeId>` (Task-5 convention). */
  selfNodeId: string;
  /** A's PINNED ES256 signing public JWK (JSON string) - the origin key. */
  peerSigningJwk: string;
  /** A's PINNED ECDH-ES encryption public JWK (JSON string) - the seal-to key. */
  peerEncryptionJwk: string;
  /** B's own encryption keypair (both JWK JSON strings) - opens replies addressed to B. */
  ownEncryptionPublicJwk: string;
  ownEncryptionPrivateJwk: string;
  /** B's own ES256 signing PRIVATE JWK (JSON string) - signs every B2A envelope. */
  ownSigningPrivateJwk: string;
  /** The sealing primitive - mcp-core's `seal` in production (injected, Task-5 doctrine). */
  seal: RelaySealFn;
  /** The opening primitive - mcp-core's `open`. */
  open: RelayOpenFn;
  /** Hand one sealed B2A frame to the link pump (the daemon's `send`, via the ctx seam). */
  sendRelayFrame(frame: RelayFrame): void;
  /** Line sink; defaults to the agent logger. Never receives keys, nonces, or agent bytes. */
  log?: (line: string) => void;
}

/** The running proxy: the composed socket path plus the two lifecycle verbs. */
export interface AgentProxyHandle {
  /** Absolute path of the listening socket (0600, inside the pane's ssh dir). */
  readonly socketPath: string;
  /**
   * Feed one INBOUND relay frame parsed off the link to this session. Only
   * A2B frames for this session's ref are honored; anything else is dropped
   * with a log line (defense in depth - the registry already routed by ref).
   * Never throws: a refused reply is a refusal, not a crash.
   */
  deliverInboundRelayFrame(frame: RelayFrame): void;
  /** Tear down: fail every live connection, stop listening, UNLINK the socket. Idempotent. */
  close(): void;
}

/**
 * The agent proxy socket path for a pane: the directory {@link
 * buildSshConfigPath} already owns for that pane's rendered config, plus
 * `agent.sock`. The helper's own guards run (absolute dataDir, an id inside
 * the path-composition shape) - it THROWS on anything else, so a caller can
 * never compose a socket outside `<dataDir>/ssh/<id>/`.
 */
export function buildAgentSocketPath(dataDir: string, paneId: string): string {
  return join(dirname(buildSshConfigPath(dataDir, paneId)), "agent.sock");
}

/** One framed agent message: 4-byte big-endian length, then the payload. */
function framing(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** A live client connection plus its receive buffer and (while outstanding) its relay slot. */
interface ConnState {
  socket: Socket;
  buffer: Buffer;
}

/**
 * Start the B-side proxy: bind the socket, then speak the ssh-agent wire until
 * `close()`. Rejects (without leaving a bound socket behind) when the pinned
 * keys are not usable PUBLIC EC P-256 JWKs - the deep private-material and
 * key-validity refusal §4.4 assigns to this side (`bytesOfJwk`).
 */
export async function startAgentProxy(args: AgentProxyArgs): Promise<AgentProxyHandle> {
  const say = args.log ?? ((line: string): void => log(line));
  const socketPath = buildAgentSocketPath(args.dataDir, args.paneId);

  // Pin sanity BEFORE binding: both peer halves must be public P-256 JWKs
  // (bytesOfJwk throws on a `d` member, a foreign curve, or junk). Parsing
  // once keeps the per-frame verify free of JSON work.
  const peerSigning = JSON.parse(args.peerSigningJwk) as JsonWebKey;
  try {
    bytesOfJwk(args.peerSigningJwk);
    bytesOfJwk(args.peerEncryptionJwk);
  } catch (err) {
    throw new Error(`relay proxy: pinned peer key rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ownSigningPrivate = JSON.parse(args.ownSigningPrivateJwk) as JsonWebKey;
  const ownEncryption = {
    principalId: `node:${args.selfNodeId}`,
    publicJwk: args.ownEncryptionPublicJwk,
    privateJwk: args.ownEncryptionPrivateJwk,
  };
  const recipient = { principalId: `node:${args.peerNodeId}`, publicJwk: args.peerEncryptionJwk };

  // The pane's ssh dir, the same 0700 posture the launch write enforces; the
  // dir may already hold the rendered config (it will, once Task 8 sequences
  // open-and-launch) and holds agent.sock beside it.
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // A stale socket file from a crashed session would make `listen` fail with
  // EADDRINUSE; the pane's ssh dir is this machine's alone, so the unlinked
  // name can only have been a previous proxy for the same pane.
  try {
    unlinkSync(socketPath);
  } catch {
    /* the clean case: no stale name */
  }

  // Session state (§5.6): B's own nonce is minted once; A's is recorded on the
  // first verified reply and signed onward after that. The gate is FRESH per
  // relay-open, and the two seqs (signed anti-replay, frame transport) start
  // at 0 and advance together on B's leg.
  const nB = newNonce();
  let nA: string | undefined;
  const gate = new SeqGate();
  let signedSeq = 0;
  let transportSeq = 0;

  const conns = new Set<ConnState>();
  /** The ONE outstanding request (the FIFO head at the relay), if any. */
  let outstanding: { conn: ConnState } | null = null;
  /** True while a seal is in flight: no slot has been taken, and no other request starts. */
  let sealedInFlight = false;
  const queue: { conn: ConnState; payload: Buffer }[] = [];
  let closed = false;

  /** Destroy a connection's socket; its close handler does the bookkeeping. */
  const failConn = (conn: ConnState): void => {
    conns.delete(conn);
    try {
      conn.socket.destroy();
    } catch {
      /* already gone */
    }
  };

  /** Nothing outstanding anymore: let the next queued request go (if any). */
  const releaseOutstanding = (): void => {
    outstanding = null;
    void pumpQueue();
  };

  /** A refused-forge frame fails every request that could be waiting on it. */
  const poisonSession = (why: string): void => {
    say(`relay session ${args.ref}: ${why}; refusing the frame and failing pending agent connections`);
    const waiting = outstanding?.conn;
    if (waiting) failConn(waiting);
    for (const q of queue.splice(0)) failConn(q.conn);
    // A seal still in flight resolves into a dead connection: sendRequest's
    // liveness re-check drops it and drains the (now empty) queue itself.
    releaseOutstanding();
  };

  /** Seal one agent request and hand the frame to the pump; then open the slot. */
  const sendRequest = async (conn: ConnState, payload: Buffer): Promise<void> => {
    const agentBytesB64 = base64UrlNoPad(new Uint8Array(payload));
    const message = {
      relaySessionId: args.relayId,
      routingRef: args.ref,
      direction: "B2A" as const,
      seq: signedSeq,
      nB,
      ...(nA === undefined ? {} : { nA }),
      agentBytesB64,
    };
    let blob: string;
    try {
      blob = await sealRelayEnvelope({ message, privateJwk: ownSigningPrivate, recipient, seal: args.seal });
    } catch (err) {
      // Malformed key material or an over-cap payload: the request is dead.
      // Cost it its connection, never the session (no seq was consumed).
      say(
        `relay session ${args.ref}: could not seal an agent request: ${err instanceof Error ? err.message : String(err)}`,
      );
      sealedInFlight = false;
      failConn(conn);
      void pumpQueue();
      return;
    }
    if (closed) return;
    if (!conns.has(conn)) {
      // The connection died mid-seal: its reply would have nowhere to go, so
      // the slot is not taken and the queue drains straight away.
      sealedInFlight = false;
      void pumpQueue();
      return;
    }
    signedSeq += 1;
    try {
      args.sendRelayFrame({
        type: "relay",
        ref: args.ref,
        seq: transportSeq,
        direction: "B2A",
        blob,
      });
    } catch (err) {
      say(`relay session ${args.ref}: the link pump refused a request: ${String(err)}`);
    }
    transportSeq += 1;
    sealedInFlight = false;
    // The slot HOLDS the frame's reply: further requests queue until it lands
    // (or the connection dies and its close handler frees the slot).
    outstanding = { conn };
    void pumpQueue();
  };

  /** Start the next queued request if the relay slot is free. */
  const pumpQueue = async (): Promise<void> => {
    if (closed || sealedInFlight || outstanding) return;
    const next = queue.shift();
    if (!next) return;
    sealedInFlight = true;
    void sendRequest(next.conn, next.payload);
  };

  /** One complete inbound agent message from one connection. */
  const handleAgentRequest = (conn: ConnState, payload: Buffer): void => {
    if (closed) return;
    if (!outstanding && !sealedInFlight) {
      sealedInFlight = true;
      void sendRequest(conn, payload);
      return;
    }
    queue.push({ conn, payload }); // serializes behind the outstanding request (§5.6 FIFO)
  };

  const onConnection = (socket: Socket): void => {
    const conn: ConnState = { socket, buffer: Buffer.alloc(0) };
    conns.add(conn);
    socket.on("data", (chunk: Buffer) => {
      conn.buffer = conn.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([conn.buffer, chunk]);
      for (;;) {
        if (conn.buffer.length < 4) return;
        const length = conn.buffer.readUInt32BE(0);
        if (length > MAX_AGENT_MESSAGE_BYTES) {
          // A length prefix past the wire cap is noise or an attack: the
          // payload is never buffered, and the connection is over.
          say(`relay session ${args.ref}: agent message over the cap (${length} bytes); connection failed`);
          failConn(conn);
          return;
        }
        if (conn.buffer.length < 4 + length) return;
        const payload = conn.buffer.subarray(4, 4 + length);
        conn.buffer = conn.buffer.subarray(4 + length);
        handleAgentRequest(conn, Buffer.from(payload));
        if (!conns.has(conn)) return; // the handler failed this connection mid-loop
      }
    });
    const forget = (): void => {
      if (!conns.delete(conn)) return;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i].conn === conn) queue.splice(i, 1);
      }
      // A mid-seal death needs no bookkeeping here: sendRequest re-checks
      // liveness before taking the slot, and drops the sealed frame if the
      // connection is gone.
      if (outstanding?.conn === conn && !sealedInFlight) releaseOutstanding();
    };
    socket.on("close", forget);
    socket.on("error", () => {
      /* close follows; never throw out of the socket layer */
    });
  };

  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  // The socket is the pane user's door onto the relay: 0600, enforced the way
  // every 0600 file in this agent is - umask cannot be reasoned with, chmod
  // after the fact can.
  chmodSync(socketPath, 0o600);

  /** Open + verify one inbound reply, then write it back. Runs on the chain. */
  const deliverReply = async (frame: RelayFrame): Promise<void> => {
    if (closed) return;
    let opened;
    try {
      // The frame's OWN routing facts bind the wrapper (M-1): a relayed blob
      // addressed through another ref or direction never reaches a key.
      opened = await openRelayEnvelope({
        blob: frame.blob,
        own: ownEncryption,
        open: args.open,
        expect: { ref: frame.ref, direction: frame.direction },
      });
    } catch {
      // Unopenable noise from the routing plane (which holds B's public key
      // and can craft seals all by itself, §5.6). Cost it a log line; the
      // pane's pending request stays alive.
      say(`relay session ${args.ref}: refused an inbound frame (envelope did not open)`);
      return;
    }
    let message;
    try {
      // The Task-5 caller checklist, every binding the endpoint holds (I-1):
      // origin against A's pinned signing key, this session's relayId, the
      // recorded nonces, and the frame-agreed routing triple. An openable
      // wrapper with a foreign signature or another session's facts is a
      // FORGERY against the pin, not noise: refuse it and fail the
      // connections that could consume anything built on this exchange.
      message = await verifyRelayEnvelope({
        jws: opened.jws,
        publicJwk: peerSigning,
        expect: {
          routingRef: args.ref,
          direction: "A2B",
          seq: opened.seq,
          relaySessionId: args.relayId,
          nB,
          ...(nA === undefined ? {} : { nA }),
        },
      });
    } catch {
      poisonSession("reply failed origin/binding verification");
      return;
    }
    if (!gate.accept("A2B", message.seq)) {
      // The plane routes - and can resend - everything (§5.6). A resend is
      // refused, not punished: no bytes to the socket, no harm to the stream.
      say(`relay session ${args.ref}: refused a replayed/rewound reply (seq ${message.seq})`);
      return;
    }
    if (nA === undefined) nA = message.nA; // record A's nonce on the first verified reply
    const payload = Buffer.from(message.agentBytesB64, "base64url");
    const waiting = outstanding;
    if (!waiting) {
      say(`relay session ${args.ref}: a reply with no outstanding request was dropped`);
      return;
    }
    outstanding = null;
    try {
      waiting.conn.socket.write(framing(payload));
    } catch {
      /* the close handler already forgot it */
    }
    void pumpQueue();
  };

  // Replies are processed in ARRIVAL order, one chain deep: the SeqGate is
  // per-session and must never race two opens out of order.
  let deliverChain: Promise<void> = Promise.resolve();

  return {
    socketPath,
    deliverInboundRelayFrame(frame: RelayFrame): void {
      if (closed) return;
      if (frame.ref !== args.ref || frame.direction !== "A2B") {
        // Misrouting is a registry bug, not a threat; a B2A frame is B's own
        // echo. Either way it never reaches the reply path.
        say(`relay session ${args.ref}: dropped a non-A2B or foreign-ref inbound frame`);
        return;
      }
      deliverChain = deliverChain
        .then(() => deliverReply(frame))
        .catch((err: unknown) => {
          say(`relay session ${args.ref}: inbound handling failed: ${String(err)}`);
        });
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const conn of [...conns]) failConn(conn);
      for (const q of queue.splice(0)) failConn(q.conn);
      try {
        server.close();
      } catch {
        /* already closed */
      }
      // The listen name goes with the session (§5.2: unbinds at teardown); an
      // unlink failure leaves a stale name the NEXT proxy start unlinks.
      try {
        unlinkSync(socketPath);
      } catch {
        /* never bound, or already gone */
      }
    },
  };
}
