import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  type SshRuntimeHelloWire,
  SshSessionFrameDecoder,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { until } from "@/__tests__/helpers/until.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import { RuntimeSessionLauncher } from "@/services/ssh-runtime/runtime-session-launcher.js";
import { SshRuntimeSession } from "@/services/ssh-runtime/session.js";
import {
  registerSession,
  resetSessionRegistryForTests,
  sessionHooks,
} from "@/services/ssh-runtime/session-registry.js";
import { installSessionSettlers } from "@/services/ssh-runtime/session-settle.js";
import { SshRuntimeSessionsRepository } from "@/services/ssh-runtime/sessions.repository.js";
import { attachScriptedNode, ok, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { type AttachParams, UNNAMED_DEVICE } from "@/ws/attach-params.js";
import { attachRemoteSubshellWs, type RemoteAttachRow } from "@/ws/remote-subshell-ws.js";
import { cleanupSubshellWs, handleSubshellMessage } from "@/ws/subshell-ws.js";
import { paneStreams, resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";

/**
 * F1: the live-terminal relay serving an SSH-RUNTIME pane (design 2026-10-05
 * §4 - "list/detail/log/live/ws all stay normal"). The old refusal: the
 * relay's liveness probe consulted `getLive`, and the hidden runtime node is
 * deliberately never dialable, so every browser attach to a runtime pane
 * died at `4004 node offline` while REST input/log/capture worked (the
 * acceptance run's F1). The relay now speaks the `NodeLauncher` interface,
 * and the liveness authority for a runtime row is the LIVE SESSION.
 *
 * The loop is as real as this seam gets: the scripted connecting node carries
 * the framed commands over the real `sendCommand` chain, and the runtime
 * answers each inner frame the way `runtime/dispatch.ts` does. Pinned:
 * - replay first, then live bytes, keystrokes reaching the pane's input
 *   frame with the ack, and the tail torn down on close (the browser contract
 *   the agent-node relay already had, now on the session twin);
 * - no live session (never opened / settled lost) -> 4004, unchanged;
 * - a session that goes lost mid-attach CLOSES the viewer's socket (1012,
 *   the retry convention, reason "session lost") - the socket learns
 *   unavailability the way every channel death teaches it, never a stream
 *   pretending to still be live.
 */

installSessionSettlers(); // the REAL settle writes the loss test asserts through

const SID = "7d0f2c34-11aa-4b5c-8d9e-0f1a2b3c4d5e";
const OWNER_UID = "u-rts-owner";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

interface Rts {
  session: SshRuntimeSession;
  /** Inner runtime frames the scripted destination saw, in wire order. */
  innerTypes: string[];
  /** The `subId` the relay handed to `tail_start` (the output subscription). */
  tailSubId: () => string;
  detach: () => void;
}

async function mkRuntimeSession(opts: { register: boolean }): Promise<Rts> {
  const target: SshSessionTargetWire = { alias: "rts", host: "127.0.0.1", port: 22, user: null, identityFile: null };
  const hello: SshRuntimeHelloWire = {
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: ["ssh-runtime", "callback-sock", "detect", "pane-callback-sock"],
    homeDir: "/home/dst",
    dataDir: "/home/dst/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-rts00000000",
    paneCount: 0,
  };
  const connectingNodeId = crypto.randomUUID();
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const nodesRepo = new NodesRepository(db);
  const sessionsRepo = new SshRuntimeSessionsRepository(db);
  await nodesRepo.create({
    id: connectingNodeId,
    ownerUserId: OWNER_UID,
    name: `rts-${sessionId.slice(0, 8)}`,
    kind: "agent",
  });
  await nodesRepo.create({
    id: runtimeNodeId,
    ownerUserId: OWNER_UID,
    name: `rts-rt-${sessionId.slice(0, 8)}`,
    kind: NODE_KIND_RUNTIME,
    status: "online",
    lastSeenAt: new Date().toISOString(),
  });
  await sessionsRepo.create({
    id: sessionId,
    ownerUserId: OWNER_UID,
    connectingNodeId,
    runtimeNodeId,
    alias: target.alias,
    host: target.host,
    port: target.port,
    user: target.user,
    status: "active",
  });
  await sessionsRepo.settle(sessionId, "active", JSON.stringify(hello));
  // One fixed pane id across cases in this shared file-DB: clear any prior
  // case's row first (the relay contract is per-id, the id is reused like
  // `remote-subshell-ws.test.ts` does for its viewer-reset rule).
  await new SubshellsRepository(db).delete(SID).catch(() => {});
  await new SubshellsRepository(db).create({
    id: SID,
    userId: OWNER_UID,
    harnessId: "terminal",
    name: "rts pane",
    workingDir: "/home/dst/work",
    presetId: null,
    nodeId: runtimeNodeId,
    tmuxSocket: `sock-${SID}`,
    status: "running",
    alive: 1,
    startedAt: new Date().toISOString(),
    notify: 1,
    crossAgent: 0,
  });
  const session = new SshRuntimeSession({
    id: sessionId,
    ownerId: OWNER_UID,
    connectingNodeId,
    runtimeNodeId,
    target,
    hello,
  });
  session.hooks = sessionHooks();
  if (opts.register) {
    // The launch verb's registration (row -> token -> frame order): the
    // loss-settle walks `paneIds()`, so the pane must be carried to have the
    // viewer drop exercised. The plaintext is test-local memory, as in
    // production it would be.
    session.registerPane(SID, "dc0e1f2a-3b4c-4d5e-8f60-rts-fake-mint");
    registerSession(session);
  }

  const innerTypes: string[] = [];
  const innerFrames: Record<string, unknown>[] = [];
  let tailRef: { subId: string } | undefined;
  const sim: ScriptedNode = attachScriptedNode(connectingNodeId, {
    ssh_session_close: ok,
    ssh_session_send: (cmd) => {
      if (cmd.type !== "ssh_session_send") throw new Error("wrong cmd");
      for (const frame of new SshSessionFrameDecoder().push(new Uint8Array(Buffer.from(cmd.data_b64, "base64")))) {
        const inner = frame as {
          type?: string;
          ref?: string;
          subId?: string;
          fromByte?: number;
          maxBytes?: number;
        };
        if (inner.ref === undefined || inner.type === undefined) continue;
        innerTypes.push(inner.type);
        innerFrames.push(inner as Record<string, unknown>);
        const answer = (data?: unknown): void =>
          session.ingestBytes(
            encodeSshSessionFrame({
              type: "result",
              ref: inner.ref as string,
              ok: true,
              ...(data !== undefined ? { data: data as never } : {}),
            }),
          );
        switch (inner.type) {
          case "probe":
            answer([{ subshellId: SID, alive: true, exitCode: null }]);
            break;
          case "log_read": {
            const full = "ab\ncd\n";
            answer(
              inner.maxBytes === 1
                ? { bytes_b64: b64(full.slice(0, 1)), next: Math.min(1, full.length), size: full.length }
                : { bytes_b64: b64(full), next: full.length, size: full.length },
            );
            break;
          }
          case "capture":
            answer("SCREEN");
            break;
          case "tail_start":
            tailRef = { subId: inner.subId as string };
            answer();
            break;
          case "pane_size":
            answer({ cols: 80, rows: 24 });
            break;
          case "pane_cursor":
            answer({ x: 0, y: 0 });
            break;
          default:
            answer();
        }
      }
      return undefined;
    },
  });

  return {
    session,
    innerTypes,
    tailSubId: () => {
      if (tailRef === undefined) throw new Error("tail_start never reached the wire");
      return tailRef.subId;
    },
    detach: () => sim.detach(),
  };
}

interface FakeBrowser {
  ws: WsSocket;
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

function fakeBrowser(): FakeBrowser {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws: WsSocket = {
    data: {},
    send: (d: string) => {
      sent.push(d);
      return 0;
    },
    // Production closes always land a `close` event, and the plugin's handler
    // runs `cleanupSubshellWs` - the fake mirrors the chain so disposal (the
    // tail_stop on a settle-driven drop) is proven, not assumed.
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
      cleanupSubshellWs(ws);
    },
    raw: {},
  } as unknown as WsSocket;
  return { ws, sent, closed };
}

function attachParams(over: Partial<AttachParams> = {}): AttachParams {
  return { size: null, deviceLabel: UNNAMED_DEVICE, hidden: false, build: "MISSING", wireMode: "json", ...over };
}

function attachRow(nodeId: string): RemoteAttachRow {
  return { id: SID, nodeId, tmuxSocket: `sock-${SID}`, userId: OWNER_UID, startedAt: new Date().toISOString() };
}

const framesOf = (sent: string[], type: string): Record<string, unknown>[] =>
  sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.type === type);

beforeAll(async () => {
  await runMigrations(); // the relay's persistOutput lastOutputAt write + the rows this fixture creates
});

beforeEach(async () => {
  resetSessionRegistryForTests();
  resetLiveViewersForTests();
  paneStreams.resetForTests();
  await new UserMetaRepository(db).setTerminalReplayLines(OWNER_UID, null);
});

afterEach(() => {
  resetSessionRegistryForTests();
  resetLiveViewersForTests();
  paneStreams.resetForTests();
});

describe("runtime-pane live attach (F1)", () => {
  it("replays, streams session output, takes the keystroke through the same writer, acks it", async () => {
    const rts = await mkRuntimeSession({ register: true });
    const { ws, sent, closed } = fakeBrowser();
    try {
      await attachRemoteSubshellWs(
        ws,
        attachRow(rts.session.runtimeNodeId),
        new RuntimeSessionLauncher(rts.session),
        "owner",
        attachParams(),
      );
      await until(() => rts.innerTypes.includes("tail_start"), "tail_start on the wire");
      expect(closed).toEqual([]); // the session-backed liveness passed - NO 4004

      // The relay's flow on the framed channel: probe (liveness) first, the
      // JOIN size probe second, then the tail, the capture, the cursor and
      // the geometry read (the async tail's exact interleaving with the
      // capture is the launcher's business, not the browser's).
      expect(rts.innerTypes.slice(0, 2)).toEqual(["probe", "log_read"]);
      for (const t of ["tail_start", "capture", "pane_cursor", "pane_size"]) {
        expect(rts.innerTypes, `${t} on the wire`).toContain(t);
      }
      const replay = framesOf(sent, "replay");
      expect(replay.length).toBe(1);
      expect(String(replay[0]?.data)).toContain("SCREEN");

      // Live bytes: an `output` frame for the relay's tail subscription rides
      // the session's pump out to the browser as an `output` frame. The
      // offsets continue the JOIN point exactly (the log's 6 bytes at attach)
      // - a frame starting before the cursor would be partially duplicate.
      const subId = rts.tailSubId();
      rts.session.ingestBytes(
        encodeSshSessionFrame({ type: "output", subId, subshellId: SID, fromByte: 6, toByte: 8, data_b64: b64("hi") }),
      );
      await until(() => framesOf(sent, "output").some((f) => String(f.data).includes("hi")), "output frame delivered");

      // A keystroke through the SHARED message handler reaches the session's
      // `input` frame - the same writer REST input uses - and is acked.
      handleSubshellMessage(ws, { type: "input", data: "x", id: 7 });
      await until(() => rts.innerTypes.includes("input"), "input frame on the wire");
      await until(() => framesOf(sent, "ack").some((f) => f.id === 7), "ack for the committed write");

      cleanupSubshellWs(ws);
      await until(() => rts.innerTypes.includes("tail_stop"), "tail_stop on close");
    } finally {
      rts.detach();
    }
  });

  it("refuses a row whose session is not live with the 4004 it always gave", async () => {
    const rts = await mkRuntimeSession({ register: false });
    const { ws, sent, closed } = fakeBrowser();
    try {
      await attachRemoteSubshellWs(
        ws,
        attachRow(rts.session.runtimeNodeId),
        new RuntimeSessionLauncher(rts.session),
        "owner",
        attachParams(),
      );
      expect(closed).toEqual([{ code: 4004, reason: "node offline" }]);
      expect(sent).toEqual([]);
    } finally {
      rts.detach();
    }
  });

  it("a session that goes lost closes the live viewer with 1012, never a dead stream", async () => {
    const rts = await mkRuntimeSession({ register: true });
    const { ws, closed } = fakeBrowser();
    try {
      await attachRemoteSubshellWs(
        ws,
        attachRow(rts.session.runtimeNodeId),
        new RuntimeSessionLauncher(rts.session),
        "owner",
        attachParams(),
      );
      await until(() => rts.innerTypes.includes("tail_start"), "attached");
      expect(closed).toEqual([]);

      rts.session.markLost("child-lost"); // the honest death: hooks -> settleLost -> viewer drop
      await until(
        () => closed.some((c) => c.code === 1012 && c.reason === "session lost"),
        "the viewer socket closed on the loss",
      );
      // The row went unavailable through the same settle, and the pump is
      // gone with the viewer (the disposer's `tail_stop` is fire-and-forget
      // and the dead session's command refuses it - correctly: there is no
      // channel left to stop. What must not survive is the local stream).
      const row = await new SubshellsRepository(db).findById(SID);
      expect(row?.alive).toBe(0);
      await until(() => paneStreams.viewerCount(SID) === 0, "the pump disposed with the dropped viewer");
    } finally {
      rts.detach();
    }
  });
});
