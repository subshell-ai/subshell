/**
 * Unit coverage for the live session's own promises (design 2026-10-05 §2/§4):
 * the fail-closed ingest (codec, second hello, inbound overflow), the output
 * subscription delivery, the pane-token registry, and the idempotent loss
 * transition. None of this touches the DB or the node link: the byte channel
 * is exercised by feeding pumped chunks directly.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  SSH_SESSION_INBOUND_QUEUE_FRAMES,
  type SshRuntimeHelloWire,
  type SshRuntimeReportRow,
  SshSessionFrameDecoder,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { SERVER_PORT } from "@/constants.js";
import * as nodeRpc from "@/services/nodes/node-rpc.js";
import { type SessionLossReason, SshRuntimeSession } from "../session.js";
import { sessionHooks } from "../session-registry.js";

const SESSION_ID = "0f4c1a7e-9b62-4a11-8d3e-5c2b1a0f9e8d";
const PANE_ID = "1e5d2b8f-0a73-5c22-9e41-6d3c2b1a0f7c";

function hello(): SshRuntimeHelloWire {
  return {
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: ["panes", "callback-sock"],
    homeDir: "/home/theo",
    dataDir: "/home/theo/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-ab12cd34ef56",
    paneCount: 0,
  };
}

function target(): SshSessionTargetWire {
  return { alias: "e2edest", host: "127.0.0.1", port: 2222, user: "theo", identityFile: null };
}

function newSession(): {
  session: SshRuntimeSession;
  losses: SessionLossReason[];
  exits: [string, number | null][];
  reports: SshRuntimeReportRow[][];
  /** Mutable box: the `onClosed` hook counts into it as settles land async. */
  closeBox: { closes: number };
  /** Every settle/report hook call in arrival order (the N-D order pin: the census must be observed strictly before the close). */
  hookOrder: string[];
} {
  const session = new SshRuntimeSession({
    id: SESSION_ID,
    ownerId: "u1",
    connectingNodeId: "n1",
    runtimeNodeId: "r1",
    target: target(),
    hello: hello(),
  });
  const losses: SessionLossReason[] = [];
  const exits: [string, number | null][] = [];
  const reports: SshRuntimeReportRow[][] = [];
  const box = { closes: 0 };
  const hookOrder: string[] = [];
  session.hooks = {
    ...session.hooks,
    onLost: (s, reason) => {
      losses.push(reason);
      hookOrder.push(`lost:${reason}`);
      expect(s.id).toBe(SESSION_ID);
    },
    onPaneExit: (_s, id, code) => {
      exits.push([id, code]);
      hookOrder.push(`exit:${id}`);
    },
    onReport: (_s, rows) => {
      reports.push(rows);
      hookOrder.push("report");
    },
    onClosed: (_s) => {
      box.closes += 1;
      hookOrder.push("closed");
    },
  };
  return { session, losses, exits, reports, closeBox: box, hookOrder };
}

describe("SshRuntimeSession.ingestBytes", () => {
  test("a codec failure is terminal: status lost, one hook call, later bytes ignored", () => {
    const { session, losses } = newSession();
    const body = new TextEncoder().encode("this is not json");
    const framed = new Uint8Array(4 + body.byteLength);
    new DataView(framed.buffer).setUint32(0, body.byteLength, false);
    framed.set(body, 4);
    session.ingestBytes(framed);
    expect(session.status).toBe("lost");
    expect(losses).toEqual(["codec"]);
    // feeding a valid frame after the loss changes nothing (no throw, no hook)
    session.ingestBytes(encodeSshSessionFrame({ type: "result", ref: SESSION_ID, ok: true }));
    expect(losses).toEqual(["codec"]);
  });
  test("a second hello is protocol noise, not a resync", () => {
    const { session, losses } = newSession();
    session.ingestBytes(encodeSshSessionFrame(hello()));
    expect(session.status).toBe("lost");
    expect(losses).toEqual(["codec"]);
  });
  test("an inbound batch over the queue cap closes the session fail-closed", () => {
    const { session, losses } = newSession();
    const one = encodeSshSessionFrame({ type: "result", ref: SESSION_ID, ok: true });
    const batch = new Uint8Array(one.byteLength * (SSH_SESSION_INBOUND_QUEUE_FRAMES + 1));
    for (let i = 0; i <= SSH_SESSION_INBOUND_QUEUE_FRAMES; i++) batch.set(one, i * one.byteLength);
    session.ingestBytes(batch);
    expect(losses).toEqual(["frame-overflow"]);
    expect(session.status).toBe("lost");
  });
  test("just under the cap does NOT overflow", () => {
    const { session, losses } = newSession();
    const one = encodeSshSessionFrame({ type: "result", ref: SESSION_ID, ok: true });
    const batch = new Uint8Array(one.byteLength * SSH_SESSION_INBOUND_QUEUE_FRAMES);
    for (let i = 0; i < SSH_SESSION_INBOUND_QUEUE_FRAMES; i++) batch.set(one, i * one.byteLength);
    session.ingestBytes(batch);
    expect(losses).toEqual([]);
    expect(session.status).toBe("active");
  });
  test("output events deliver decoded bytes only to a matching (subId, pane) pair", () => {
    const { session } = newSession();
    const seen: [string, number][] = [];
    session.subscribeOutput("sub-a", PANE_ID, (bytes, next) => seen.push([Buffer.from(bytes).toString("utf8"), next]));
    const chunk = Buffer.from("hello pane").toString("base64");
    session.ingestBytes(
      encodeSshSessionFrame({
        type: "output",
        subshellId: PANE_ID,
        subId: "sub-a",
        fromByte: 0,
        toByte: 10,
        data_b64: chunk,
      }),
    );
    // wrong subId: dropped silently (another subscription's bytes)
    session.ingestBytes(
      encodeSshSessionFrame({
        type: "output",
        subshellId: PANE_ID,
        subId: "sub-b",
        fromByte: 0,
        toByte: 10,
        data_b64: chunk,
      }),
    );
    // wrong pane id under a right subId: also dropped (the pairing is the guard)
    session.ingestBytes(
      encodeSshSessionFrame({
        type: "output",
        subshellId: "other-pane",
        subId: "sub-a",
        fromByte: 0,
        toByte: 10,
        data_b64: chunk,
      }),
    );
    expect(seen).toEqual([["hello pane", 10]]);
  });
  test("exit frames reach the hooks and loss is idempotent", () => {
    const { session, losses, exits } = newSession();
    session.ingestBytes(
      encodeSshSessionFrame({ type: "exit", subshellId: PANE_ID, exitCode: 3, at: "2026-10-05T00:00:00Z" }),
    );
    expect(exits).toEqual([[PANE_ID, 3]]);
    session.markLost("child-lost");
    session.markLost("node-disconnected");
    expect(losses).toEqual(["child-lost"]); // the second transition is a no-op
    expect(session.status).toBe("lost");
  });
});

/**
 * The graceful close (review C1): the `close` frame MUST leave the plane
 * before the status flips (a pre-flip `close()` refused its own command, so
 * the runtime never heard, the SSH child leaked, and the doc claimed a census
 * that never arrived). These tests intercept `sendCommand` - the only outbound
 * door - and pin the frame order the close promises.
 */
describe("SshRuntimeSession.close (the C1 order: frame first, census, then settle)", () => {
  /** Every `ssh_session_send` payload sent to "n1" while a test ran. */
  function interceptSendCommand(outcome: "ack" | "reject" = "ack"): {
    frames: { ref: string; data_b64: string }[];
    restore: () => void;
  } {
    const frames: { ref: string; data_b64: string }[] = [];
    const original = nodeRpc.sendCommand;
    mock.module("@/services/nodes/node-rpc.js", () => ({
      ...nodeRpc,
      sendCommand: async (nodeId: string, cmd: { type: string; ref?: string; data_b64?: string }) => {
        if (nodeId === "n1" && cmd.type === "ssh_session_send") {
          frames.push({ ref: cmd.ref ?? "", data_b64: cmd.data_b64 ?? "" });
        }
        if (outcome === "reject") throw new Error("node offline");
        return { ok: true };
      },
    }));
    return {
      frames,
      restore: () => mock.module("@/services/nodes/node-rpc.js", () => ({ ...nodeRpc, sendCommand: original })),
    };
  }

  /** Run the microtask/timer queue until `cond` holds (bounded). */
  async function tickUntil(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
    if (!cond()) throw new Error("tickUntil: condition never held");
  }

  const decodeCloseFrames = (frames: { data_b64: string }[]): string[] => {
    const out: string[] = [];
    for (const f of frames) {
      const bytes = new Uint8Array(Buffer.from(f.data_b64, "base64"));
      const d = new SshSessionFrameDecoder();
      for (const raw of d.push(bytes)) {
        if (raw !== null && typeof raw === "object" && "type" in raw) out.push(String((raw as { type: string }).type));
      }
    }
    return out;
  };

  test("close sends the `close` frame BEFORE settling (the regression: the pre-flip status made command() refuse its own frame)", async () => {
    const { session, reports, closeBox, hookOrder } = newSession();
    // A registered pane (review N-D): the census rows must name a pane the
    // session actually carries, or the report-vs-close ordering claim holds
    // only vacuously.
    session.registerPane(PANE_ID, "subshell_pane_token");
    const { frames, restore } = interceptSendCommand();
    try {
      const closer = session.close();
      await tickUntil(() => frames.length === 1);
      // Find the pending command ref (the close's ref) from the encoded frame.
      const d = new SshSessionFrameDecoder();
      const bytes = new Uint8Array(Buffer.from(frames[0]?.data_b64 ?? "", "base64"));
      const [frame] = d.push(bytes);
      expect(frame).not.toBeNull();
      const closeRef = (frame as { ref: string }).ref;
      session.ingestBytes(
        encodeSshSessionFrame({
          type: "result",
          ref: closeRef,
          ok: true,
          data: [{ subshellId: PANE_ID, alive: false, exitCode: 0 }],
        }),
      );
      await closer;
      // The frame carried a `close` command out while the session was active.
      expect(decodeCloseFrames(frames)).toEqual(["close"]);
      // The census rode the result and was delivered before the closed settle
      // - in that OBSERVED order, asserted on the hook sequence, not just the
      // fact that both fired (the N-D pin).
      expect(reports).toEqual([[{ subshellId: PANE_ID, alive: false, exitCode: 0 }]]);
      expect(hookOrder).toEqual(["report", "closed"]);
      expect(session.status).toBe("closed");
      expect(closeBox.closes).toBe(1);
    } finally {
      restore();
    }
  });

  test("close settles closed when the runtime refuses the close instead of reporting (no census is invented)", async () => {
    const { session, reports, closeBox } = newSession();
    const { frames, restore } = interceptSendCommand();
    try {
      const closer = session.close();
      await tickUntil(() => frames.length === 1);
      const d = new SshSessionFrameDecoder();
      const [frame] = d.push(new Uint8Array(Buffer.from(frames[0]?.data_b64 ?? "", "base64")));
      const closeRef = (frame as { ref: string }).ref;
      session.ingestBytes(encodeSshSessionFrame({ type: "result", ref: closeRef, ok: false, error: "shutting" }));
      await closer;
      expect(session.status).toBe("closed");
      expect(closeBox.closes).toBe(1);
      expect(reports).toEqual([]); // nothing was reported; nothing was invented
    } finally {
      restore();
    }
  });

  test("a transport death during close keeps the `send-failed` loss as the owner (design §6 Disconnect outranks the act)", async () => {
    const { session, losses, closeBox } = newSession();
    const { frames, restore } = interceptSendCommand("reject");
    try {
      await session.close();
      expect(frames.length).toBe(1); // the frame attempt went out WHILE active (the bug died here)
      expect(losses).toEqual(["send-failed"]); // the link failure is the honest fact
      expect(session.status).toBe("lost");
      expect(closeBox.closes).toBe(0); // close deferred to the loss settling
    } finally {
      restore();
    }
  });

  test("a second close is a no-op (the latch; no duplicate frame, no second onClosed)", async () => {
    const { session, closeBox } = newSession();
    const { frames, restore } = interceptSendCommand();
    try {
      const both = Promise.all([session.close(), session.close()]);
      await tickUntil(() => frames.length === 1);
      const d = new SshSessionFrameDecoder();
      const [frame] = d.push(new Uint8Array(Buffer.from(frames[0]?.data_b64 ?? "", "base64")));
      session.ingestBytes(
        encodeSshSessionFrame({ type: "result", ref: (frame as { ref: string }).ref, ok: true, data: [] }),
      );
      await both;
      expect(closeBox.closes).toBe(1);
      expect(decodeCloseFrames(frames)).toEqual(["close"]); // exactly one close frame left
    } finally {
      restore();
    }
  });

  test("a mid-close death keeps the `lost` settle as the owner (close adds no second transition)", async () => {
    const { session, losses, closeBox } = newSession();
    const { frames, restore } = interceptSendCommand();
    try {
      const closer = session.close();
      await tickUntil(() => frames.length === 1);
      session.markLost("child-lost"); // the channel died while the close command was in flight
      await closer;
      expect(losses).toEqual(["child-lost"]);
      expect(session.status).toBe("lost");
      expect(closeBox.closes).toBe(0); // close deferred to the lost settle
      expect(frames.length).toBe(1); // one frame went out while it was still active
    } finally {
      restore();
    }
  });
});

/**
 * The callback surface under adversarial ids (review I-A): the inbound
 * grammar bounds `reqId` (length + printable), and the plane's answer path
 * must stay honest under both halves of that fact - an unbounded id REFUSES
 * the frame fail-closed (never a callback sized around a length nobody
 * bounded), and an answer that cannot be encoded is a logged refusal, never
 * an unhandled rejection escaping the void call site.
 */
describe("callback reqId honesty (I-A)", () => {
  test("a rest_request with an unbounded reqId is refused at the parse: lost fail-closed, no callback started", () => {
    const { session, losses, hookOrder } = newSession();
    let resolverRan = false;
    session.hooks = {
      ...session.hooks,
      resolveCallbackPane: () => {
        resolverRan = true;
        return PANE_ID;
      },
    };
    session.ingestBytes(
      encodeSshSessionFrame({
        type: "rest_request",
        reqId: "x".repeat(100),
        method: "GET",
        path: "/api/subshells/anything",
      }),
    );
    expect(session.status).toBe("lost");
    expect(losses).toEqual(["codec"]); // the grammar refusal IS the codec-verdict path
    expect(resolverRan).toBe(false); // nothing was attempted with the refused id
    expect(hookOrder.filter((h) => h.startsWith("report"))).toEqual([]);
  });

  test("a non-printable reqId refuses too, and an honest 64-char id (the cap) still round-trips to the hooks", () => {
    const { session, losses } = newSession();
    session.ingestBytes(
      encodeSshSessionFrame({ type: "rest_request", reqId: "a\u0001b", method: "GET", path: "/api/x" }),
    );
    expect(losses).toEqual(["codec"]);

    const seen: string[] = [];
    const { session: live } = newSession();
    live.hooks = {
      ...live.hooks,
      resolveCallbackPane: (_s, path, method) => {
        seen.push(`${method} ${path}`);
        return null; // refuse 403; the test is about the id arriving, not the answer
      },
    };
    const capId = '"'.repeat(64); // printable, worst legal escape cost
    live.ingestBytes(encodeSshSessionFrame({ type: "rest_request", reqId: capId, method: "get", path: "/api/x" }));
    expect(seen).toEqual(["GET /api/x"]); // the id passed grammar; the frame reached the hooks
    expect(live.status).toBe("active");
    expect(losses).toEqual(["codec"]); // the first session's verdict stands; this one lost nothing
  });

  test("an answer the codec refuses (oversize body from a rogue executor) is a logged refusal, never an unhandled rejection", async () => {
    const { session, losses } = newSession();
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);
    const sent: { data_b64: string }[] = [];
    const original = nodeRpc.sendCommand;
    mock.module("@/services/nodes/node-rpc.js", () => ({
      ...nodeRpc,
      sendCommand: async (_nodeId: string, cmd: { type: string; data_b64?: string }) => {
        if (cmd.type === "ssh_session_send") sent.push({ data_b64: cmd.data_b64 ?? "" });
        return { ok: true };
      },
    }));
    try {
      session.hooks = {
        ...session.hooks,
        resolveCallbackPane: () => PANE_ID,
        // A deliberately unfitted answer: 300 KB cannot encode into a 256 KiB
        // frame. The production executor caps bodies before this point; the
        // belt in `#answerCallback` must survive one that does not.
        executeCallback: async () => ({ status: 200, body: "x".repeat(300_000) }),
      };
      session.ingestBytes(
        encodeSshSessionFrame({
          type: "rest_request",
          reqId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
          method: "GET",
          path: "/api/subshells/own",
        }),
      );
      await new Promise((r) => setTimeout(r, 20)); // let the void round trip run to completion
      expect(rejections).toEqual([]); // the belt caught what would have escaped as an unhandled rejection
      expect(losses).toEqual([]); // a refused ANSWER is not a lost session
      expect(session.status).toBe("active");
      expect(sent).toEqual([]); // the over-cap frame never reached the node link
    } finally {
      process.off("unhandledRejection", onRejection);
      mock.module("@/services/nodes/node-rpc.js", () => ({ ...nodeRpc, sendCommand: original }));
    }
  });
});

/**
 * The C2 traversal closure (review 2026-10-06): the plane normalizes the
 * forwarded path with `new URL` BEFORE the allowlist match and executes the
 * SAME normalized value, so the two normalization points cannot disagree.
 * Real `sessionHooks()` wiring (the registry's matcher), a global-fetch spy
 * (so a slipped traversal would be VISIBLE as a fetch to the wrong route,
 * not an accidental real request), and intercepted `rest_response` frames.
 */
describe("callback path normalization (C2)", () => {
  const OWN = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";

  function wireRealHooks(session: SshRuntimeSession): { fetchCalls: string[]; sent: { status: number }[] } {
    session.hooks = sessionHooks();
    session.registerPane(OWN, "subshell_token_for_own_pane");
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const sent: { status: number }[] = [];
    const original = nodeRpc.sendCommand;
    mock.module("@/services/nodes/node-rpc.js", () => ({
      ...nodeRpc,
      sendCommand: async (_nodeId: string, cmd: { type: string; data_b64?: string }) => {
        if (cmd.type === "ssh_session_send") {
          const d = new SshSessionFrameDecoder();
          for (const raw of d.push(new Uint8Array(Buffer.from(cmd.data_b64 ?? "", "base64")))) {
            const f = raw as { type?: string; status?: number };
            if (f.type === "rest_response") sent.push({ status: f.status ?? -1 });
          }
        }
        return { ok: true };
      },
    }));
    (restoreBag as { fetch: typeof fetch; rpc: typeof nodeRpc.sendCommand }).fetch = originalFetch;
    (restoreBag as { fetch: typeof fetch; rpc: typeof nodeRpc.sendCommand }).rpc = original;
    return { fetchCalls, sent };
  }
  const restoreBag: Record<string, unknown> = {};
  const restore = (): void => {
    globalThis.fetch = restoreBag.fetch as typeof fetch;
    mock.module("@/services/nodes/node-rpc.js", () => ({ ...nodeRpc, sendCommand: restoreBag.rpc }));
  };

  const request = (session: SshRuntimeSession, path: string): void => {
    session.ingestBytes(
      encodeSshSessionFrame({ type: "rest_request", reqId: crypto.randomUUID(), method: "GET", path, paneId: OWN }),
    );
  };

  test("own-id-then-../ to /api/users: normalized before matching, refused 403, NOTHING fetched", async () => {
    const { session } = newSession();
    const { fetchCalls, sent } = wireRealHooks(session);
    try {
      request(session, `/api/subshells/${OWN}/../../users`);
      await new Promise((r) => setTimeout(r, 30));
      expect(fetchCalls, "the traversal must never reach the executor").toEqual([]);
      expect(sent).toEqual([{ status: 403 }]);
    } finally {
      restore();
    }
  });

  test("own-id-then-../ back to another pane's route: refused even though the first segment names own", async () => {
    const { session } = newSession();
    const { fetchCalls, sent } = wireRealHooks(session);
    try {
      request(session, `/api/subshells/${OWN}/../1e5d2b8f-0a73-5c22-9e41-6d3c2b1a0f7c/input`);
      await new Promise((r) => setTimeout(r, 30));
      expect(fetchCalls).toEqual([]);
      expect(sent).toEqual([{ status: 403 }]);
    } finally {
      restore();
    }
  });

  test("a same-tree dot detour EXECUTES the normalized own path, not the raw string", async () => {
    const { session } = newSession();
    const { fetchCalls, sent } = wireRealHooks(session);
    try {
      // `..` back into own id then down: the NORMALIZED path IS the allowed
      // own route; the executor must be handed exactly that, on loopback.
      request(session, `/api/subshells/other/../${OWN}/input`);
      await new Promise((r) => setTimeout(r, 30));
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]).toBe(`http://127.0.0.1:${SERVER_PORT}/api/subshells/${OWN}/input`);
      expect(sent).toEqual([{ status: 200 }]);
    } finally {
      restore();
    }
  });

  test("query glue is uniform: /api/subshells/<own>?x=1 matches (id intact) and the search rides through", async () => {
    const { session } = newSession();
    const { fetchCalls, sent } = wireRealHooks(session);
    try {
      request(session, `/api/subshells/${OWN}?x=1`);
      await new Promise((r) => setTimeout(r, 30));
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]).toBe(`http://127.0.0.1:${SERVER_PORT}/api/subshells/${OWN}?x=1`);
      expect(sent).toEqual([{ status: 200 }]);
    } finally {
      restore();
    }
  });
});

describe("SshRuntimeSession pane registry", () => {
  test("token plaintext lives only in the session and leaves with the pane", () => {
    const { session } = newSession();
    session.registerPane(PANE_ID, "subshell_secret_plaintext");
    expect(session.paneToken(PANE_ID)).toBe("subshell_secret_plaintext");
    expect(session.paneIds()).toEqual([PANE_ID]);
    session.unregisterPane(PANE_ID);
    expect(session.paneToken(PANE_ID)).toBeUndefined();
    expect(session.paneIds()).toEqual([]);
  });
  test("the callback socket path composes from the hello's dataDir", () => {
    const { session } = newSession();
    expect(session.callbackSockPath).toBe(`${hello().dataDir}/callback.sock`);
  });
});
