/**
 * Unit coverage for the live session's own promises (design 2026-10-05 §2/§4):
 * the fail-closed ingest (codec, second hello, inbound overflow), the output
 * subscription delivery, the pane-token registry, and the idempotent loss
 * transition. None of this touches the DB or the node link: the byte channel
 * is exercised by feeding pumped chunks directly.
 */
import { describe, expect, test } from "bun:test";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  SSH_SESSION_INBOUND_QUEUE_FRAMES,
  type SshRuntimeHelloWire,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
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

function newSession(): { session: SshRuntimeSession; losses: SessionLossReason[]; exits: [string, number | null][] } {
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
  session.hooks = {
    ...session.hooks,
    onLost: (s, reason) => {
      losses.push(reason);
      expect(s.id).toBe(SESSION_ID);
    },
    onPaneExit: (_s, id, code) => {
      exits.push([id, code]);
    },
  };
  return { session, losses, exits };
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
