import {
  encodeSshSessionFrame,
  parseSshRuntimeEventFrame,
  parseSshRuntimeReportRows,
  SSH_SESSION_FRAME_MAX_BYTES,
  SSH_SESSION_INBOUND_QUEUE_FRAMES,
  type SshRuntimeCommandFrame,
  type SshRuntimeHelloWire,
  type SshRuntimeReportRow,
  SshSessionFrameDecoder,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * One LIVE brokered session's byte channel (design 2026-10-05 §3/§4): the
 * plane end of the runtime link. The SSH child is the connecting node's; this
 * object owns the framing codec, the command correlation, the output
 * subscriptions, the pane-token registry, and the callback round trips.
 *
 * The two promises this object carries:
 *
 * - **Backpressure at the plane's own sink.** The child's stdout arrives as
 *   `session_frame` events the node has already throttled against the node
 *   link; between the frame and a plane handler there is no queue this process
 *   may grow without bound, so an ingest batch larger than
 *   {@link SSH_SESSION_INBOUND_QUEUE_FRAMES} frames CLOSES the session
 *   fail-closed (design §2's overflow rule, executed where the bytes arrive).
 * - **Ordering.** Plane->runtime frames are one serialized chain per session
 *   (`#sendChain`): the runtime's serial dispatcher already enforces execution
 *   order, and a writer that raced two sends through two concurrent RPCs would
 *   scramble the order that chain exists to preserve (the node link's own
 *   `sendChain` lesson, one layer up).
 */

/** A session command the runtime refused, or a command that cannot reach a live runtime. */
export class SshRuntimeCommandError extends Error {
  /** The runtime's verbatim refusal (an equality-mapped code where one exists), or the transport verdict. */
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "SshRuntimeCommandError";
    this.detail = detail;
  }
}

/** One pending command's correlation entry. */
interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One live output subscription (a `tail_start` pump on the runtime side). */
interface OutputSubscriber {
  subshellId: string;
  onChunk: (bytes: Uint8Array, next: number) => void;
}

/** The callback answer shape the executor hands back. */
export interface CallbackAnswer {
  status: number;
  body: string;
}

/** A close transition's witness, for the log line and the row write. */
export type SessionLossReason = "child-lost" | "node-disconnected" | "frame-overflow" | "codec" | "send-failed";

/**
 * The event hooks the registry wires onto every session it registers. One
 * shared object serves all sessions (every handler takes the session as its
 * first argument), and wiring happens at registration so the class imports
 * nothing from the registry - the cycle would otherwise be structural, not
 * just textual.
 */
export interface SessionEventHooks {
  onLost: (session: SshRuntimeSession, reason: SessionLossReason) => void;
  onClosed: (session: SshRuntimeSession) => void;
  onPaneExit: (session: SshRuntimeSession, subshellId: string, exitCode: number | null, at: string) => void;
  onReport: (
    session: SshRuntimeSession,
    rows: { subshellId: string; alive: boolean; exitCode: number | null }[],
  ) => void;
  /** The allowlist decision (the matcher is the pure module; null = refuse 403). */
  resolveCallbackPane: (session: SshRuntimeSession, path: string, method: string) => string | null;
  /** The allowlisted execution as the pane's own token. */
  executeCallback: (
    session: SshRuntimeSession,
    paneId: string,
    method: string,
    path: string,
    body: string | undefined,
  ) => Promise<CallbackAnswer>;
}

/** The un-wired default: every hook is a no-op, and a callback answers 403 by refusing. */
const UNWIRED_HOOKS: SessionEventHooks = {
  onLost: () => {},
  onClosed: () => {},
  onPaneExit: () => {},
  onReport: () => {},
  resolveCallbackPane: () => null,
  executeCallback: async () => ({ status: 500, body: JSON.stringify({ error: "not wired" }) }),
};

export class SshRuntimeSession {
  readonly id: string;
  readonly ownerId: string;
  readonly connectingNodeId: string;
  readonly runtimeNodeId: string;
  readonly target: SshSessionTargetWire;
  /** The parsed hello (set once by the service immediately after construction). */
  hello: SshRuntimeHelloWire;
  /** The runtime's callback socket path (composed from hello.dataDir; design §5's one listener). */
  readonly callbackSockPath: string;
  /** Registry-installed event wiring (see the interface). */
  hooks: SessionEventHooks = UNWIRED_HOOKS;

  #status: "active" | "lost" | "closed" = "active";
  /** Latch against double-close racing the in-flight `close` command (the runtime exits once; one frame per session). */
  #closeRequested = false;
  readonly #decoder = new SshSessionFrameDecoder();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #outputSubs = new Map<string, OutputSubscriber>();
  /** Pane id -> the token PLAINTEXT minted for it (never transmitted to the destination). */
  readonly #paneTokens = new Map<string, string>();
  #sendChain: Promise<void> = Promise.resolve();
  #callbacksInFlight = 0;

  constructor(init: {
    id: string;
    ownerId: string;
    connectingNodeId: string;
    runtimeNodeId: string;
    target: SshSessionTargetWire;
    hello: SshRuntimeHelloWire;
  }) {
    this.id = init.id;
    this.ownerId = init.ownerId;
    this.connectingNodeId = init.connectingNodeId;
    this.runtimeNodeId = init.runtimeNodeId;
    this.target = init.target;
    this.hello = init.hello;
    this.callbackSockPath = `${init.hello.dataDir}/callback.sock`;
  }

  get status(): "active" | "lost" | "closed" {
    return this.#status;
  }

  /** Pane identity + its minted token, recorded when the service creates the pane (the callback's executing identity). */
  registerPane(subshellId: string, tokenPlaintext: string): void {
    this.#paneTokens.set(subshellId, tokenPlaintext);
  }

  /** Forget one pane (terminate/delete): its token leaves memory with it. */
  unregisterPane(subshellId: string): void {
    this.#paneTokens.delete(subshellId);
  }

  /** The session's pane ids (the close sweep revokes tokens through the service). */
  paneIds(): string[] {
    return [...this.#paneTokens.keys()];
  }

  /** The pane token for the callback executor (the ONLY holder of runtime pane plaintexts). */
  paneToken(subshellId: string): string | undefined {
    return this.#paneTokens.get(subshellId);
  }

  /**
   * Feed one pumped chunk of child stdout (a `session_frame` event's bytes).
   * The decoder is fail-closed, so any codec verdict marks the session lost
   * rather than skipping bytes; an oversized batch (the plane cannot drain its
   * own session) closes it too, design §2's overflow rule.
   */
  ingestBytes(chunk: Uint8Array): void {
    if (this.#status !== "active") return; // a dead channel drops late frames (the close report already answered)
    const frames = this.#decoder.push(chunk);
    if (this.#decoder.failed !== null) {
      this.markLost("codec");
      return;
    }
    if (frames.length > SSH_SESSION_INBOUND_QUEUE_FRAMES) {
      this.markLost("frame-overflow");
      return;
    }
    for (const raw of frames) this.#handleFrame(raw);
  }

  /** The `ssh_session_lost` close report or the node link's own death: the channel is over, and nothing replays. */
  markLost(reason: SessionLossReason): void {
    if (this.#status !== "active") return;
    this.#status = "lost";
    this.#failPendings(`session ${this.id.slice(0, 8)} ${reason}`);
    this.hooks.onLost(this, reason);
  }

  /**
   * Run the graceful close (design §6): send the `close` command WHILE the
   * session is still active (flipping first would make `command` refuse to
   * encode it - the frame is the whole point of the graceful path), await the
   * runtime's answer, and settle regardless of it - an unreachable child's
   * `closed` is still the user's act.
   *
   * The census is the `close` command's RESULT data (`finalReport` in
   * `runtime/serve.ts` answers it before exiting): when it arrives it is
   * delivered through `onReport` BEFORE `onClosed`, so the close settling sees
   * panes as the destination reported them (dead panes carry their exit codes;
   * the settle still flips survivors to `alive: 0` - a live pane with a dead
   * channel is the design §6 unavailable reading, not a completed one).
   *
   * A mid-close death (the child dies while the result is in flight) leaves
   * the `lost` settling as the owner of the transition: `markLost` wins and
   * this method does nothing further.
   */
  async close(): Promise<void> {
    if (this.#status !== "active" || this.#closeRequested) return;
    this.#closeRequested = true;
    let census: SshRuntimeReportRow[] | null = null;
    try {
      const data = await this.command({ type: "close", ref: crypto.randomUUID() }, 15_000);
      census = parseSshRuntimeReportRows(data);
    } catch (err) {
      logger.debug(`ssh-runtime close of ${this.id.slice(0, 8)} answered nothing: ${String(err)}`);
    }
    if (this.#status !== "active") return; // died mid-close: the lost settle owns the transition
    this.#status = "closed";
    if (census !== null) this.hooks.onReport(this, census);
    this.#failPendings("session closed");
    this.hooks.onClosed(this);
  }

  /**
   * Send one command frame and await its `result{ref}`. The runtime ref IS
   * the correlation id (the broker keys by the outer session ref, so inner
   * collisions could only ever be plane-side, and one uuid per command keeps
   * even that impossible).
   */
  command(frame: Exclude<SshRuntimeCommandFrame, { type: "rest_response" }>, timeoutMs: number): Promise<unknown> {
    if (this.#status !== "active") {
      return Promise.reject(
        new SshRuntimeCommandError(`session ${this.id.slice(0, 8)} is ${this.#status}`, "session_unknown"),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(frame.ref)) {
          reject(new SshRuntimeCommandError(`runtime command ${frame.type} timed out`, "timeout"));
        }
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(frame.ref, { resolve, reject, timer });
      this.#enqueueBytes(encodeSshSessionFrame(frame), reject);
    });
  }

  /** Subscribe to one `tail_start` pump's output events; returns the unsubscribe. */
  subscribeOutput(subId: string, subshellId: string, onChunk: (bytes: Uint8Array, next: number) => void): () => void {
    this.#outputSubs.set(subId, { subshellId, onChunk });
    return () => {
      this.#outputSubs.delete(subId);
    };
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Serialize outbound writes (module doc's ordering promise) and map a node
   * failure to a session loss: if the frame cannot reach the child, the
   * channel is gone, and a half-open session is never reported as open.
   */
  #enqueueBytes(bytes: Uint8Array, onError: (err: Error) => void): void {
    if (bytes.byteLength > SSH_SESSION_FRAME_MAX_BYTES) {
      onError(new SshRuntimeCommandError("outbound runtime frame exceeds the session cap", "oversize"));
      return;
    }
    const data_b64 = Buffer.from(bytes).toString("base64");
    this.#sendChain = this.#sendChain.then(async () => {
      if (this.#status !== "active") {
        onError(new SshRuntimeCommandError(`session ${this.id.slice(0, 8)} is ${this.#status}`, "session_unknown"));
        return;
      }
      try {
        await sendCommand(
          this.connectingNodeId,
          { type: "ssh_session_send", ref: this.id, data_b64 },
          { timeoutMs: 15_000 },
        );
      } catch (err) {
        this.markLost("send-failed");
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  #handleFrame(raw: unknown): void {
    const frame = parseSshRuntimeEventFrame(raw);
    if (frame === null) {
      // The codec accepted the bytes; the SESSION grammar refuses them. Same
      // class as a codec failure: the other end is not speaking the agreed
      // protocol, and fail-closed is the only honest reading.
      this.markLost("codec");
      return;
    }
    switch (frame.type) {
      case "hello":
        // A second hello (the first one answered the open) is protocol noise.
        this.markLost("codec");
        return;
      case "result": {
        const pending = this.#pending.get(frame.ref);
        if (!pending) return; // late answer after a timeout: the caller already moved on
        this.#pending.delete(frame.ref);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.data);
        else pending.reject(new SshRuntimeCommandError(`runtime refused: ${frame.error}`, frame.error));
        return;
      }
      case "output": {
        const sub = this.#outputSubs.get(frame.subId);
        if (sub && sub.subshellId === frame.subshellId) {
          try {
            sub.onChunk(Buffer.from(frame.data_b64, "base64"), frame.toByte);
          } catch (err) {
            logger.withError(err).debug(`ssh-runtime tail delivery failed for ${frame.subshellId}`);
          }
        }
        return;
      }
      case "exit":
        this.hooks.onPaneExit(this, frame.subshellId, frame.exitCode, frame.at);
        return;
      case "subshells_report":
        this.hooks.onReport(this, frame.subshells);
        return;
      case "rest_request":
        void this.#answerCallback(frame.reqId, frame.method, frame.path, frame.body);
        return;
    }
  }

  /**
   * The callback round trip (design §5): allowlist, execute as the pane's own
   * token, relay the answer as `rest_response`. Bound the in-flight count: a
   * chatty (or prompt-injected) pane gets 8 callbacks in flight, then 503s -
   * the honest refusal shape, and it keeps the session's RPC chain free for
   * pane work.
   */
  async #answerCallback(reqId: string, method: string, path: string, body: string | undefined): Promise<void> {
    const settle = (status: number, text: string): void => {
      this.#enqueueBytes(
        encodeSshSessionFrame({
          type: "rest_response",
          reqId,
          status,
          ...(text !== "" ? { body: text } : {}),
        } satisfies Extract<SshRuntimeCommandFrame, { type: "rest_response" }>),
        () => {},
      );
    };
    if (this.#callbacksInFlight >= 8) {
      settle(503, JSON.stringify({ error: "too many callbacks in flight" }));
      return;
    }
    const paneId = this.hooks.resolveCallbackPane(this, path, method);
    if (paneId === null) {
      settle(403, JSON.stringify({ error: "forbidden" }));
      return;
    }
    this.#callbacksInFlight += 1;
    try {
      const answer = await this.hooks.executeCallback(this, paneId, method, path, body);
      settle(answer.status, answer.body);
    } catch (err) {
      logger.withError(err).warn(`ssh-runtime callback execution failed for ${path}`);
      settle(502, JSON.stringify({ error: "callback execution failed" }));
    } finally {
      this.#callbacksInFlight -= 1;
    }
  }

  #failPendings(reason: string): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new SshRuntimeCommandError(reason, "lost"));
    }
    this.#pending.clear();
    // Tail subscribers stop via their own disposers; the subscriptions are
    // meaningless now, so drop them (a later `tail_stop` relay from a disposer
    // answers `session_unknown`, harmlessly).
    this.#outputSubs.clear();
  }
}
