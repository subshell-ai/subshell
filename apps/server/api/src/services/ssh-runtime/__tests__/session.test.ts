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
import * as nodeRpc from "@/services/nodes/node-rpc.js";
import { type SessionLossReason, SshRuntimeSession } from "../session.js";

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
  session.hooks = {
    ...session.hooks,
    onLost: (s, reason) => {
      losses.push(reason);
      expect(s.id).toBe(SESSION_ID);
    },
    onPaneExit: (_s, id, code) => {
      exits.push([id, code]);
    },
    onReport: (_s, rows) => {
      reports.push(rows);
    },
    onClosed: (_s) => {
      box.closes += 1;
    },
  };
  return { session, losses, exits, reports, closeBox: box };
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
    const { session, reports, closeBox } = newSession();
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
      // The census rode the result and was delivered before the closed settle.
      expect(reports).toEqual([[{ subshellId: PANE_ID, alive: false, exitCode: 0 }]]);
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
