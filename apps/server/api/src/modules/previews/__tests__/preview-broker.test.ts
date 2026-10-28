import { beforeEach, describe, expect, it } from "bun:test";
import {
  type NodeCommandBody,
  type NodeEvent,
  type NodePreviewPortsResult,
  type NodePreviewScreenWire,
  PREVIEW_FRAME_MAX_BYTES,
  PREVIEW_IDLE_MS,
  PREVIEW_LANE_BUFFER_MAX_BYTES,
  PREVIEW_LANE_QUEUE_MAX,
  PREVIEW_LIFETIME_MAX_MS,
  PREVIEW_STREAM_DEBT_MAX,
  PREVIEW_WATCH_SUBSCRIBERS_MAX,
  type PreviewCloseReason,
  type PreviewDataFrame,
} from "@internal/subshell-protocol";
import { sql } from "kysely";
import { getRequestlessContext } from "@/app/context.js";
import { db } from "@/db/index.js";
import type { ShareEntry } from "@/db/repositories/subshell-shares.repository.js";
import { NodeRpcError } from "@/modules/nodes/node-rpc.js";
import {
  configurePreviewStreamSender,
  getPreviewBroker,
  PreviewRefusal,
  type PreviewStreamSender,
  resetForTests,
} from "@/modules/previews/preview-broker.js";
import type { Access } from "@/modules/subshells/access.js";
import { SubshellsService } from "@/modules/subshells/subshells.service.js";
import { getLogger } from "@/shared/logger.js";
import { ensureMigratedTestDb } from "@/testing/test-database.js";

/**
 * The plane-side preview broker (spec 2026-10-21 §5-§7, Task 8). Every seam
 * is faked except the audit rows: those land in the file's own migrated DB,
 * because the audit vocabulary is a deliverable operators read.
 *
 * The wire fakes record every command so a test can assert both what rode
 * the link and what deliberately did not: the idempotent DELETE, the
 * wire-only lane close, the node-reported close answered with nothing.
 */

const NODE = "n-preview";
const PANE = "p-preview-pane";

/** One valid 32-hex ref, for events naming a lane that never existed. */
const GHOST_REF = "ab".repeat(16);

interface Harness {
  clock: { now: number };
  sent: { nodeId: string; cmd: NodeCommandBody }[];
  linked: { nodeId: string; frame: PreviewDataFrame }[];
  delivered: { socket: unknown; frame: Parameters<PreviewStreamSender>[1] }[];
  accessCalls: { userId: string; paneId: string }[];
  /** Held acks: one entry per command whose ack is parked (what "in flight" counts). */
  held: { cmd: NodeCommandBody; release: () => void; refuse: (err: Error) => void }[];
}

interface FakeSeams {
  cdpPort?: number;
  ack?: (cmd: NodeCommandBody) => unknown;
  /** Name the commands whose ack parks until the test releases/refuses it. */
  hold?: (cmd: NodeCommandBody) => boolean;
  accessFor?: (userId: string, paneId: string) => Promise<Access>;
  /** Pass `null` to build a broker with NO fan-out sender at all. */
  sendToSockets?: PreviewStreamSender | null;
}

/**
 * Builds the broker over named seams. The default ack answers every preview
 * command: `preview_open` echoes the ref back (`pending` for a forward lane,
 * a lie of `subscribers: 1` for the bridge, which the broker must ignore and
 * count itself), `preview_close` accepts, and `preview_ports_get` reports an
 * empty machine with no screen.
 */
function makeHarness(over: FakeSeams = {}): Harness {
  const clock = { now: 1_780_000_000_000 };
  const h: Harness = { clock, sent: [], linked: [], delivered: [], accessCalls: [], held: [] };
  const defaultSendToSockets: PreviewStreamSender = (socket, frame) => {
    h.delivered.push({ socket, frame });
  };
  resetForTests({
    now: () => clock.now,
    send: async (nodeId: string, cmd: NodeCommandBody): Promise<unknown> => {
      h.sent.push({ nodeId, cmd });
      const ackFor = (): unknown => {
        if (over.ack) return over.ack(cmd);
        switch (cmd.type) {
          case "preview_open":
            return cmd.kind === "forward" ? { ref: cmd.ref, pending: true } : { ref: cmd.ref, subscribers: 1 };
          case "preview_close":
            return { ref: cmd.ref, closed: true };
          case "preview_ports_get":
            return { ports: [], cdpPort: over.cdpPort ?? null, screen: null };
          default:
            throw new Error(`preview broker test: unexpected command ${cmd.type}`);
        }
      };
      if (over.hold?.(cmd)) {
        return new Promise<unknown>((resolve, reject) => {
          h.held.push({ cmd, release: () => resolve(ackFor()), refuse: (err) => reject(err) });
        });
      }
      return ackFor();
    },
    linkSend: (nodeId: string, frame: PreviewDataFrame): void => {
      h.linked.push({ nodeId, frame });
    },
    accessFor: over.accessFor
      ? async (userId: string, paneId: string): Promise<Access> => {
          h.accessCalls.push({ userId, paneId });
          return (await over.accessFor?.(userId, paneId)) ?? "none";
        }
      : undefined,
    // `null` means "no sender configured", which is what production looks
    // like until Task 11 calls configurePreviewStreamSender.
    ...(over.sendToSockets === null ? {} : { sendToSockets: over.sendToSockets ?? defaultSendToSockets }),
  });
  return h;
}

/** Parked-ack helpers for the concurrency discriminators (no non-null assertions). */
function releaseHeld(h: Harness): void {
  h.held.shift()?.release();
}

function refuseHeld(h: Harness, err: Error): void {
  h.held.shift()?.refuse(err);
}

function cmds<T extends NodeCommandBody["type"]>(h: Harness, type: T): Extract<NodeCommandBody, { type: T }>[] {
  return h.sent.filter((c) => c.cmd.type === type).map((c) => c.cmd) as Extract<NodeCommandBody, { type: T }>[];
}

/** Lets fire-and-forget audit writes (real DB) land before the read. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

async function auditRows(action: string): Promise<{ action: string; metadataJson: string | null }[]> {
  return await db.selectFrom("auditEvents").where("action", "=", action).select(["action", "metadataJson"]).execute();
}

async function metadataOf(action: string): Promise<Record<string, unknown>[]> {
  const rows = await auditRows(action);
  return rows.map((r) => JSON.parse(String(r.metadataJson)) as Record<string, unknown>);
}

const SCREEN: NodePreviewScreenWire = { display: ":7", viewer: { protocol: "vnc", port: 5900 } };

function portsAnswer(over: Partial<NodePreviewPortsResult> = {}): NodePreviewPortsResult {
  return { ports: [{ proto: "tcp", port: 8080, pid: 11 }], cdpPort: 9222, screen: null, ...over };
}

/**
 * A sendable fake of the exported structural socket interface. `withDebtMethod:
 * false` builds one WITHOUT `getBufferedAmount` at all (the raw Bun socket
 * carries the method, the Elysia wrapper carries neither form; Task 11's
 * adapter supplies it, and a sibling fake without it must read as zero debt).
 */
function fakeSocket(opts: { debt?: () => number; withDebtMethod?: boolean } = {}): {
  frames: string[];
  send(data: string): unknown;
  getBufferedAmount?: () => number;
} {
  const frames: string[] = [];
  const socket: { frames: string[]; send(data: string): unknown; getBufferedAmount?: () => number } = {
    frames,
    send: (data: string) => {
      frames.push(data);
      return data.length;
    },
  };
  if (opts.withDebtMethod === false) return socket;
  socket.getBufferedAmount = opts.debt ?? (() => 0);
  return socket;
}

const broker = getPreviewBroker;

function streamEvent(ref: string, seq: number): Extract<NodeEvent, { type: "preview_stream" }> {
  return { type: "preview_stream", ref, seq, w: 100, h: 50, ts: 1_780_000_000_000 + seq, blob: `blob-${seq}` };
}

/** The pane's live bridge (screencast session), for tests that never saw its ref. */
function bridgeFor(paneId: string): ReturnType<ReturnType<typeof getPreviewBroker>["sessionForPane"]> {
  return broker().sessionForPane(paneId);
}

beforeEach(async () => {
  await ensureMigratedTestDb();
  await db.deleteFrom("auditEvents").execute();
});

describe("openForward: the probe, the mint, the session", () => {
  it("sends the probe at the lifetime cap, mints a 32-hex ref, closes the probe wire-only", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });

    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    const opens = cmds(h, "preview_open");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toEqual({
      type: "preview_open",
      ref,
      kind: "forward",
      paneId: PANE,
      port: 8080,
      lifetimeMs: PREVIEW_LIFETIME_MAX_MS,
    });
    // The probe lane closes on the wire (the node must not park a dead lane),
    // and the close is wire-only: the audit pair names SESSIONS, not lanes.
    expect(cmds(h, "preview_close")).toEqual([{ type: "preview_close", ref, reason: "viewer-left" }]);

    const openAudits = await metadataOf("node.preview_forward.open");
    expect(openAudits).toHaveLength(1);
    expect(openAudits[0]).toEqual({ paneId: PANE, nodeId: NODE, port: 8080, kind: "forward" });
    // The ref is the /pv path credential: it appears in no audit row.
    for (const row of await auditRows("node.preview_forward.open")) {
      expect(row.metadataJson).not.toContain(ref);
    }
    expect(await auditRows("node.preview_forward.close")).toHaveLength(0);

    const session = broker().sessionFor(ref);
    expect(session).not.toBeNull();
    expect(session?.kind).toBe("forward");
    expect(session?.mode).toBe("http");
    expect(session?.createdBy).toBe("u-open");
    expect(session?.port).toBe(8080);
    expect(session?.cookieJar.size).toBe(0);
  });

  it("two opens for one pane mint DIFFERENT refs (the ref is a secret, not a slot)", async () => {
    makeHarness();
    const a = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const b = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    expect(a.ref).not.toBe(b.ref);
    expect(b.ref).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a node refusal propagates named and records nothing", async () => {
    const h = makeHarness({
      ack: (cmd) => {
        if (cmd.type === "preview_open") {
          throw new NodeRpcError("failed", 'node "x" reported: refused', NODE, "preview-lane-over-node-cap");
        }
        return { ports: [], cdpPort: null, screen: null };
      },
    });
    await expect(
      broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 }),
    ).rejects.toMatchObject({ name: "NodeRpcError", detail: "preview-lane-over-node-cap" });
    expect(cmds(h, "preview_close")).toHaveLength(0);
    expect(await auditRows("node.preview_forward.open")).toHaveLength(0);
  });

  it("mode is raw exactly at the screen's rfbPort, by the live ports answer first", async () => {
    const h = makeHarness({
      ack: (cmd) =>
        cmd.type === "preview_ports_get"
          ? portsAnswer({ screen: SCREEN })
          : cmd.type === "preview_open"
            ? { ref: cmd.ref, pending: true }
            : {},
    });
    const raw = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 5900 });
    const http = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    expect(broker().sessionFor(raw.ref)?.mode).toBe("raw");
    expect(broker().sessionFor(http.ref)?.mode).toBe("http");
    // The screen came from getPorts alone: no display memory existed this run.
    expect(cmds(h, "preview_open")).toHaveLength(2);
  });

  it("plane-restart regression: after resetForTests the ports answer ALONE still lands raw", async () => {
    // Memory-only discrimination would ship `http` here and re-handshake raw
    // RFB over an http proxy lane (decision 6).
    makeHarness({
      ack: (cmd) =>
        cmd.type === "preview_ports_get"
          ? portsAnswer({ screen: SCREEN })
          : cmd.type === "preview_open"
            ? { ref: cmd.ref, pending: true }
            : {},
    });
    const first = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 5900 });
    expect(broker().sessionFor(first.ref)?.mode).toBe("raw");

    // Fresh broker (fresh memory), SAME fake ports answer.
    makeHarness({
      ack: (cmd) =>
        cmd.type === "preview_ports_get"
          ? portsAnswer({ screen: SCREEN })
          : cmd.type === "preview_open"
            ? { ref: cmd.ref, pending: true }
            : {},
    });
    const second = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 5900 });
    expect(broker().sessionFor(second.ref)?.mode).toBe("raw");
  });

  it("mac leg: a refused ports walk falls back to the onDisplayOpened memory", async () => {
    makeHarness({
      ack: (cmd) => {
        if (cmd.type === "preview_ports_get") {
          throw new NodeRpcError("failed", "refused", NODE, "preview-ports-unsupported");
        }
        if (cmd.type === "preview_open") return { ref: cmd.ref, pending: true };
        return {};
      },
    });
    broker().onDisplayOpened(NODE, PANE, SCREEN);
    const raw = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 5900 });
    const http = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    expect(broker().sessionFor(raw.ref)?.mode).toBe("raw");
    expect(broker().sessionFor(http.ref)?.mode).toBe("http");
  });
});

describe("lane pools: the per-pane cap, the queue, the close", () => {
  it("four lanes open, the fifth through twelfth queue, the thirteenth refuses; a close promotes a waiter", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });

    const lanes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const lane = await broker().openLaneForConnection(ref);
      expect(lane.laneRef).toMatch(/^[0-9a-f]{32}$/);
      lanes.push(lane.laneRef);
    }
    expect(lanes).toEqual([...new Set(lanes)]);

    // Eight queued waiters: pending, and they mint no lane while queued.
    const settled: string[] = [];
    const waiters = Array.from({ length: PREVIEW_LANE_QUEUE_MAX }, () =>
      broker()
        .openLaneForConnection(ref)
        .then((l) => {
          settled.push(l.laneRef);
          return l.laneRef;
        }),
    );
    await settle();
    expect(settled).toHaveLength(0);
    expect(cmds(h, "preview_open")).toHaveLength(5); // probe + 4 lanes

    // The next in the door past the cap AND past the queue refuses named.
    await expect(broker().openLaneForConnection(ref)).rejects.toBeInstanceOf(PreviewRefusal);
    await expect(broker().openLaneForConnection(ref)).rejects.toMatchObject({ code: "preview-lane-over-cap" });

    // Releasing one lane frees the node slot AND promotes the first waiter.
    await broker().closeLaneForConnection(lanes[0], "viewer-left");
    await settle();
    expect(settled).toHaveLength(1);
    const promoted = await waiters[0];
    expect(promoted).toMatch(/^[0-9a-f]{32}$/);
    expect(promoted).not.toBe(lanes[0]);

    expect(cmds(h, "preview_open")).toHaveLength(6);
    expect(cmds(h, "preview_close")).toContainEqual({ type: "preview_close", ref: lanes[0], reason: "viewer-left" });
    // Lane closes audit nothing; the pair belongs to the session.
    expect(await auditRows("node.preview_forward.close")).toHaveLength(0);
    // Seven waiters stay queued when this test ends, and the NEXT test's
    // resetForTests shutdown rejects them. Marking those rejections handled
    // here is what keeps the reset from surfacing as an unhandled error
    // against a test that never touched the queue.
    for (const w of waiters.slice(1)) w.catch(() => {});
  });

  it("closeLaneForConnection frees the node slot immediately and ends subscribers with the reason", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    const events: ({ bytes: Uint8Array } | { closed: PreviewCloseReason })[] = [];
    broker().subscribeLane(laneRef, (e) => events.push(e));

    await broker().closeLaneForConnection(laneRef, "viewer-left");
    expect(cmds(h, "preview_close")).toContainEqual({ type: "preview_close", ref: laneRef, reason: "viewer-left" });
    expect(events).toEqual([{ closed: "viewer-left" }]);
    // The lane is gone: a late byte send drops instead of resurrecting it.
    h.linked.length = 0;
    broker().sendLaneBytes(laneRef, new Uint8Array([1]));
    expect(h.linked).toHaveLength(0);
    // And a completed one-shot response's close left the session open for
    // its next connection, with no close audit.
    expect(broker().sessionFor(ref)).not.toBeNull();
    expect(await auditRows("node.preview_forward.close")).toHaveLength(0);
  });

  it("a closed pane's queued waiters are rejected, not left pending forever", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    for (let i = 0; i < 4; i += 1) await broker().openLaneForConnection(ref);
    const waiter = broker().openLaneForConnection(ref);
    await broker().closeForPane(PANE, "pane-gone");
    await expect(waiter).rejects.toBeInstanceOf(Error);
    expect(cmds(h, "preview_open")).toHaveLength(5);
  });

  it("the lane cap is per PANE, counted across the pane's sessions", async () => {
    const h = makeHarness();
    const a = await broker().openForward({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 8080 });
    const b = await broker().openForward({ viewerUserId: "u-b", paneId: PANE, nodeId: NODE, port: 8081 });
    await broker().openLaneForConnection(a.ref);
    await broker().openLaneForConnection(a.ref);
    const b1 = await broker().openLaneForConnection(b.ref);
    await broker().openLaneForConnection(b.ref);
    const settled: string[] = [];
    void broker()
      .openLaneForConnection(a.ref)
      .then((l) => {
        settled.push(l.laneRef);
      });
    await settle();
    expect(settled).toHaveLength(0);
    // A lane released under session B still promotes session A's waiter:
    // the cap is the pane's, not the session's.
    await broker().closeLaneForConnection(b1.laneRef, "viewer-left");
    await settle();
    expect(settled).toHaveLength(1);
    void h;
  });

  it("sendLaneBytes rides the byte sender, not the command RPC; traffic keeps the idle clock off", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    const got: Uint8Array[] = [];
    broker().subscribeLane(laneRef, (e) => {
      if ("bytes" in e) got.push(e.bytes);
    });

    h.clock.now += 60_000;
    broker().sendLaneBytes(laneRef, new Uint8Array([0x48, 0x69]));
    expect(h.linked).toHaveLength(1);
    expect(h.linked[0]?.nodeId).toBe(NODE);
    expect(h.linked[0]?.frame).toEqual({ type: "preview_data", ref: laneRef, dir: "in", blob: "SGk=" });
    // No command rode the RPC path for bytes: the split mirrors the relay's.
    expect(h.sent.filter((c) => c.cmd.type === ("preview_data" as NodeCommandBody["type"]))).toHaveLength(0);
    expect(got).toHaveLength(0); // an `in` send does not echo to subscribers

    // Keep traffic alive across one idle window: the sweep must skip it.
    h.clock.now += PREVIEW_IDLE_MS;
    broker().sendLaneBytes(laneRef, new Uint8Array([1]));
    expect(await broker().sweepIdle()).toBe(0);
    expect(broker().sessionFor(ref)).not.toBeNull();

    // And the OUT leg decodes to bytes for the lane's subscribers.
    broker().onNodeLaneFrame(NODE, { type: "preview_data", ref: laneRef, dir: "out", blob: "SGk=" });
    expect(Array.from(got[0] ?? [])).toEqual([0x48, 0x69]);
  });

  it("bytes over the frame cap: nothing rides the link, the lane dies over-cap, the session survives", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    const events: ({ bytes: Uint8Array } | { closed: PreviewCloseReason })[] = [];
    broker().subscribeLane(laneRef, (e) => events.push(e));

    broker().sendLaneBytes(laneRef, new Uint8Array(PREVIEW_FRAME_MAX_BYTES + 1));
    await settle();
    expect(h.linked).toHaveLength(0);
    expect(events).toEqual([{ closed: "over-cap" }]);
    expect(broker().sessionFor(ref)).not.toBeNull();
    // The ONE lane-level audit, named, carrying no ref and no byte content.
    const rows = await metadataOf("node.preview_lane.over_cap");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paneId: PANE, nodeId: NODE, port: 8080, kind: "forward", reason: "over-cap" });
    for (const row of await auditRows("node.preview_lane.over_cap")) {
      expect(row.metadataJson).not.toContain(laneRef);
    }
    // A dead lane's later sends drop quietly.
    h.linked.length = 0;
    broker().sendLaneBytes(laneRef, new Uint8Array([1]));
    expect(h.linked).toHaveLength(0);
  });

  it("a node lane frame naming an unknown ref, the wrong direction, or another node is dropped", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    const got: Uint8Array[] = [];
    broker().subscribeLane(laneRef, (e) => {
      if ("bytes" in e) got.push(e.bytes);
    });
    // An `in` leg from the node is nonsense (the plane owns that direction).
    broker().onNodeLaneFrame(NODE, { type: "preview_data", ref: laneRef, dir: "in", blob: "AQ==" });
    // A frame naming another node's ref: dropped (the socket's node is the fence).
    broker().onNodeLaneFrame("n-other", { type: "preview_data", ref: laneRef, dir: "out", blob: "AQ==" });
    broker().onNodeLaneFrame(NODE, { type: "preview_data", ref: GHOST_REF, dir: "out", blob: "AQ==" });
    expect(got).toHaveLength(0);
    expect(h.linked).toHaveLength(0);
  });

  it("a node-reported lane close ends subscribers with its reason, audits nothing, sends nothing back", async () => {
    const h = makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    const events: ({ bytes: Uint8Array } | { closed: PreviewCloseReason })[] = [];
    broker().subscribeLane(laneRef, (e) => events.push(e));

    await broker().onNodeReportedClose(NODE, laneRef, "target-gone");
    await settle();
    expect(events).toEqual([{ closed: "target-gone" }]);
    expect(broker().sessionFor(ref)).not.toBeNull();
    // Wire-only: the only preview_close on the wire is openForward's own probe
    // close from the open (which names the session ref); nothing new is sent
    // back for the lane the node already closed, and nothing is audited.
    expect(cmds(h, "preview_close").filter((c) => c.ref !== ref)).toHaveLength(0);
    expect(await auditRows("node.preview_forward.close")).toHaveLength(0);
  });

  it("retains target greetings until the proxy subscribes, without replaying them twice", async () => {
    makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 5910 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    for (const text of ["RFB ", "003.008\n"]) {
      broker().onNodeLaneFrame(NODE, {
        type: "preview_data",
        ref: laneRef,
        dir: "out",
        blob: Buffer.from(text).toString("base64"),
      });
    }
    const chunks: string[] = [];
    broker().subscribeLane(laneRef, (event) => {
      if ("bytes" in event) chunks.push(Buffer.from(event.bytes).toString());
    });
    expect(chunks.join("")).toBe("RFB 003.008\n");
    const replay: unknown[] = [];
    broker().subscribeLane(laneRef, (event) => replay.push(event));
    expect(replay).toEqual([]);
  });

  it("closes rather than retaining unbounded data before the proxy subscribes", async () => {
    makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 5910 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    for (let n = 0; n <= PREVIEW_LANE_BUFFER_MAX_BYTES; n += PREVIEW_FRAME_MAX_BYTES) {
      broker().onNodeLaneFrame(NODE, {
        type: "preview_data",
        ref: laneRef,
        dir: "out",
        blob: Buffer.alloc(PREVIEW_FRAME_MAX_BYTES).toString("base64"),
      });
    }
    const events: unknown[] = [];
    broker().subscribeLane(laneRef, (event) => events.push(event));
    expect(events).toEqual([{ closed: "target-gone" }]);
  });

  it("subscribeLane unsubscribes by the returned function and ends a missing lane immediately", async () => {
    makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const { laneRef } = await broker().openLaneForConnection(ref);
    let count = 0;
    const off = broker().subscribeLane(laneRef, () => {
      count += 1;
    });
    broker().onNodeLaneFrame(NODE, { type: "preview_data", ref: laneRef, dir: "out", blob: "AQ==" });
    expect(count).toBe(1);
    off();
    broker().onNodeLaneFrame(NODE, { type: "preview_data", ref: laneRef, dir: "out", blob: "AQ==" });
    expect(count).toBe(1);
    const late = broker().subscribeLane(GHOST_REF, (event) => {
      expect(event).toEqual({ closed: "target-gone" });
      count += 1;
    });
    late();
    expect(count).toBe(2);
  });

  it("lane callbacks never cross duplexes: one session's two lanes pump independently", async () => {
    makeHarness();
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    const a = await broker().openLaneForConnection(ref);
    const b = await broker().openLaneForConnection(ref);
    const seen: string[] = [];
    broker().subscribeLane(a.laneRef, () => seen.push("a"));
    broker().subscribeLane(b.laneRef, () => seen.push("b"));
    broker().onNodeLaneFrame(NODE, { type: "preview_data", ref: b.laneRef, dir: "out", blob: "AQ==" });
    expect(seen).toEqual(["b"]);
  });
});

describe("watch bridges: one per pane, refcounted, idempotent", () => {
  it("zero->one sends preview_open and audits once; joins ride no wire and no audit", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    const opens = cmds(h, "preview_open");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ type: "preview_open", kind: "screencast", paneId: PANE, port: 9222 });
    expect(opens[0]?.type === "preview_open" ? opens[0].ref : "").toMatch(/^[0-9a-f]{32}$/);
    expect((await auditRows("node.preview_watch.open")).length).toBe(1);
    expect(bridgeFor(PANE)?.viewers.get("u-a")).toBe(1);

    await broker().startWatch({ viewerUserId: "u-b", paneId: PANE, nodeId: NODE, port: 9222 });
    expect(cmds(h, "preview_open")).toHaveLength(1); // the ack's `subscribers: 1` is a lie the broker ignores
    expect((await auditRows("node.preview_watch.open")).length).toBe(1);
    expect(bridgeFor(PANE)?.viewers.get("u-b")).toBe(1);

    await broker().stopWatch("u-a", PANE);
    expect(cmds(h, "preview_close")).toHaveLength(0);
    await broker().stopWatch("u-b", PANE);
    const closes = cmds(h, "preview_close");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ reason: "viewer-left" });
    const watchCloses = await metadataOf("node.preview_watch.close");
    expect(watchCloses).toHaveLength(1);
    expect(watchCloses[0]).toMatchObject({
      paneId: PANE,
      nodeId: NODE,
      port: 9222,
      kind: "screencast",
      reason: "viewer-left",
    });
    expect(bridgeFor(PANE)).toBeNull();
  });

  it("two POSTs from ONE user are count 2, and the first DELETE leaves the bridge open", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-one", paneId: PANE, nodeId: NODE, port: 9222 });
    await broker().startWatch({ viewerUserId: "u-one", paneId: PANE, nodeId: NODE, port: 9222 });
    expect(bridgeFor(PANE)?.viewers.get("u-one")).toBe(2);

    await broker().stopWatch("u-one", PANE);
    expect(cmds(h, "preview_close")).toHaveLength(0);
    expect(bridgeFor(PANE)?.viewers.get("u-one")).toBe(1);
    expect(await auditRows("node.preview_watch.close")).toHaveLength(0);

    await broker().stopWatch("u-one", PANE);
    expect(cmds(h, "preview_close")).toHaveLength(1);
  });

  it("stopWatch after the zero-close, and after a node-reported teardown, answer ok and send nothing", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-one", paneId: PANE, nodeId: NODE, port: 9222 });
    await broker().stopWatch("u-one", PANE);
    const after = h.sent.length;
    expect(await broker().stopWatch("u-one", PANE)).toEqual({ ok: true });
    expect(h.sent.length).toBe(after);
    expect(await auditRows("node.preview_watch.close")).toHaveLength(1); // not 2

    // The post-teardown twin: the node's close zeroes the counts, and a
    // DELETE arriving after it must not send a second preview_close into a
    // dead bridge.
    await broker().startWatch({ viewerUserId: "u-two", paneId: PANE, nodeId: NODE, port: 9222 });
    const bridge = bridgeFor(PANE);
    expect(bridge).not.toBeNull();
    await broker().onNodeReportedClose(NODE, String(bridge?.ref), "target-gone");
    await settle();
    const sentNow = h.sent.length;
    expect(await broker().stopWatch("u-two", PANE)).toEqual({ ok: true });
    expect(h.sent.length).toBe(sentNow);
    expect((await auditRows("node.preview_watch.close")).length).toBe(2); // the report's row, not a new one
  });

  it("a POST naming another port is refused watch-port-conflict and touches no count", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    await expect(
      broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9333 }),
    ).rejects.toMatchObject({ code: "watch-port-conflict" });
    expect(bridgeFor(PANE)?.viewers.get("u-a")).toBe(1);
    expect(bridgeFor(PANE)?.viewers.size).toBe(1);
    expect(cmds(h, "preview_open")).toHaveLength(1);
    await settle();
    expect(await auditRows("node.preview_watch.open")).toHaveLength(1);
  });

  it("the subscriber cap is PER BRIDGE: eight across three users fills it, the ninth refuses touching no count", async () => {
    const h = makeHarness();
    const at = (u: string) => broker().startWatch({ viewerUserId: u, paneId: PANE, nodeId: NODE, port: 9222 });
    await at("u-a");
    await at("u-a");
    await at("u-a");
    await at("u-b");
    await at("u-b");
    await at("u-b");
    await at("u-c");
    await at("u-c");
    let sum = 0;
    for (const n of bridgeFor(PANE)?.viewers.values() ?? []) sum += n;
    expect(sum).toBe(PREVIEW_WATCH_SUBSCRIBERS_MAX);

    await expect(at("u-d")).rejects.toMatchObject({ code: "preview-watch-over-cap" });
    expect(bridgeFor(PANE)?.viewers.has("u-d")).toBe(false);
    expect(cmds(h, "preview_open")).toHaveLength(1);
  });

  it("a node refusal on the bridge open propagates and records nothing", async () => {
    const h = makeHarness({
      ack: (cmd) => {
        if (cmd.type === "preview_open" && cmd.kind === "screencast") {
          throw new NodeRpcError("failed", "refused", NODE, "preview-watch-over-node-cap");
        }
        return {};
      },
    });
    await expect(
      broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 }),
    ).rejects.toMatchObject({ detail: "preview-watch-over-node-cap" });
    expect(bridgeFor(PANE)).toBeNull();
    expect(await auditRows("node.preview_watch.open")).toHaveLength(0);
    expect(cmds(h, "preview_close")).toHaveLength(0);
  });

  it("a node-reported BRIDGE close tears the plane's half down and the next startWatch re-opens", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    const bridge = bridgeFor(PANE);
    const socket = fakeSocket();
    expect(broker().attachStream(PANE, "k-a", "u-a", socket)).toEqual({ ok: true });

    await broker().onNodeReportedClose(NODE, String(bridge?.ref), "target-gone");
    await settle();
    expect(bridgeFor(PANE)).toBeNull();
    const rows = await metadataOf("node.preview_watch.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paneId: PANE, kind: "screencast", reason: "target-gone" });
    // The plane sends no preview_close for a bridge the node already killed.
    expect(cmds(h, "preview_close")).toHaveLength(0);

    // The next startWatch hits the zero->one edge and re-sends preview_open,
    // because "a matching port just joins" may only ever join a LIVE bridge.
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    expect(cmds(h, "preview_open")).toHaveLength(2);
    const fresh = bridgeFor(PANE);
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(String(fresh?.ref), 1));
    expect(h.delivered).toHaveLength(0); // the old socket stays detached; re-watch to see frames
    broker().attachStream(PANE, "k-b", "u-a", fakeSocket());
    broker().onStreamEvent(NODE, streamEvent(String(fresh?.ref), 2));
    expect(h.delivered).toHaveLength(1);
  });
});

describe("stream sockets: the attach cap, the keying, the byte debt", () => {
  it("never delivers another viewer's browser to a socket without a watch registration", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-editor", paneId: PANE, nodeId: NODE, port: 9333 });
    broker().attachStream(PANE, "unregistered", "u-viewer", fakeSocket());
    broker().onStreamEvent(NODE, streamEvent(String(bridgeFor(PANE)?.ref), 1));
    expect(h.delivered).toEqual([]);
  });

  it("revokes a downgraded editor watching a port outside the subshell's discovered browser", async () => {
    const h = makeHarness({ accessFor: async (user) => (user === "u-editor" ? "view" : "owner") });
    await broker().startWatch({ viewerUserId: "u-editor", paneId: PANE, nodeId: NODE, port: 9333 });
    await broker().startWatch({ viewerUserId: "u-owner", paneId: PANE, nodeId: NODE, port: 9333 });
    const denied = fakeSocket();
    const owner = fakeSocket();
    broker().attachStream(PANE, "downgraded", "u-editor", denied);
    broker().attachStream(PANE, "owner", "u-owner", owner);
    await broker().closeUnauthorizedForPane(PANE);
    broker().onStreamEvent(NODE, streamEvent(String(bridgeFor(PANE)?.ref), 1));
    expect(h.delivered.map((delivery) => delivery.socket)).toEqual([owner]);
    expect(bridgeFor(PANE)?.viewers.has("u-editor")).toBe(false);
  });

  it("eight attach; the ninth is refused at attach with a viewer_drop audit while eight keep streaming", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-holder", paneId: PANE, nodeId: NODE, port: 9222 });
    const bridge = String(bridgeFor(PANE)?.ref);
    const sockets = Array.from({ length: PREVIEW_WATCH_SUBSCRIBERS_MAX }, () => fakeSocket());
    for (let i = 0; i < PREVIEW_WATCH_SUBSCRIBERS_MAX; i += 1) {
      expect(broker().attachStream(PANE, `k-${i}`, "u-holder", sockets[i])).toEqual({ ok: true });
    }
    const ninth = fakeSocket();
    expect(broker().attachStream(PANE, "k-8", "u-holder", ninth)).toEqual({
      ok: false,
      code: "preview-stream-over-cap",
    });
    await settle();
    const drops = await metadataOf("node.preview_watch.viewer_drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ paneId: PANE, reason: "over-cap" });
    expect(drops[0]).not.toHaveProperty("ref");
    // Nothing closed: the bridge still streams to the first eight.
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(bridge, 1));
    expect(h.delivered).toHaveLength(PREVIEW_WATCH_SUBSCRIBERS_MAX);
    expect(h.delivered.some((d) => d.socket === ninth)).toBe(false);
  });

  it("attach is key-based, never identity: two sockets under different keys fan out; detach stops frames", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-one", paneId: PANE, nodeId: NODE, port: 9222 });
    const bridge = String(bridgeFor(PANE)?.ref);
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    // Two tabs, ONE holder: decision 7's two-tab case on the socket half.
    expect(broker().attachStream(PANE, "conn-1", "u-one", s1)).toEqual({ ok: true });
    expect(broker().attachStream(PANE, "conn-2", "u-one", s2)).toEqual({ ok: true });

    broker().onStreamEvent(NODE, streamEvent(bridge, 7));
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[0]?.frame).toEqual({ type: "preview-stream", id: PANE, seq: 7, w: 100, h: 50, blob: "blob-7" });

    // Elysia hands the NEXT callback a fresh wrapper; the caller passes the
    // SAME per-connection id. An identity-keyed map finds nothing here.
    broker().detachStream(PANE, "conn-1");
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(bridge, 8));
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.socket).toBe(s2);

    // detachSocketsFor walks every pane by key alone (the socket's `close`
    // path hands the broker nothing but the id).
    broker().detachSocketsFor("conn-2");
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(bridge, 9));
    expect(h.delivered).toHaveLength(0);
    // And the detached keys freed their cap slots: eight can attach again.
    for (let i = 0; i < PREVIEW_WATCH_SUBSCRIBERS_MAX; i += 1) {
      expect(broker().attachStream(PANE, `re-${i}`, "u-one", fakeSocket())).toEqual({ ok: true });
    }
  });

  it("byte debt over the max detaches THAT socket with a viewer_drop audit; the bridge and siblings keep running", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    const bridge = String(bridgeFor(PANE)?.ref);
    const slow = fakeSocket({ debt: () => PREVIEW_STREAM_DEBT_MAX + 1 });
    // The sibling WITHOUT the method at all: the `?? 0` read keeps its
    // frames flowing (the property spelling is the trap the platform lacks).
    const sibling = fakeSocket({ withDebtMethod: false });
    broker().attachStream(PANE, "k-slow", "u-a", slow);
    broker().attachStream(PANE, "k-fast", "u-a", sibling);

    broker().onStreamEvent(NODE, streamEvent(bridge, 1));
    await settle();
    const drops = await metadataOf("node.preview_watch.viewer_drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ paneId: PANE, nodeId: NODE, port: 9222, kind: "screencast", reason: "slow-link" });
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(bridge, 2));
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.socket).toBe(sibling);
    // The lane and bridge untouched: the session still stands, and the drop
    // closes nothing on the wire (spec §9 drops slow VIEWERS, never the bridge).
    expect(bridgeFor(PANE)).not.toBeNull();
    expect(cmds(h, "preview_close")).toHaveLength(0);
  });

  it("an unconfigured broker never fans out: send never reaches a socket by itself", async () => {
    makeHarness({ sendToSockets: null });
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    const bridge = String(bridgeFor(PANE)?.ref);
    const socket = fakeSocket();
    expect(broker().attachStream(PANE, "k-1", "u-a", socket)).toEqual({ ok: true });
    broker().onStreamEvent(NODE, streamEvent(bridge, 1));
    await settle();
    // The broker imports nothing from ws/ and never touches socket.send.
    expect(socket.frames).toHaveLength(0);
  });

  it("configurePreviewStreamSender fills the fan-out slot for a broker built without a fake sender", async () => {
    const seen: unknown[] = [];
    // Boot order, as Task 11 calls it: the slot is filled first, and the
    // broker built after it inherits the sender. The slot is first-call-wins:
    // in a serial run the winner is decided by module-load order (this file's
    // spy fills it before live-ws.ts's module init can), and a directory move
    // would flip it. Under the parallel regime every file gets its own
    // process, so there is no contest there.
    configurePreviewStreamSender((_socket, frame) => {
      seen.push(frame);
    });
    resetForTests({
      send: async (_n, cmd) =>
        cmd.type === "preview_ports_get"
          ? portsAnswer()
          : cmd.type === "preview_open"
            ? { ref: cmd.ref, subscribers: 1 }
            : {},
    });
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    const bridge = String(bridgeFor(PANE)?.ref);
    broker().attachStream(PANE, "k-1", "u-a", fakeSocket());
    broker().onStreamEvent(NODE, streamEvent(bridge, 3));
    expect(seen).toHaveLength(1);
  });

  it("an event naming an unknown ref, or another node's bridge, fans out to nobody", async () => {
    const h = makeHarness();
    await broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    broker().attachStream(PANE, "k-1", "u-a", fakeSocket());
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(GHOST_REF, 1));
    broker().onStreamEvent("n-other", streamEvent(String(bridgeFor(PANE)?.ref), 2));
    expect(h.delivered).toHaveLength(0);
  });
});

describe("idle sweep: forward only", () => {
  it("closes the idle forward session with `idle` and leaves a watched bridge with zero frames untouched", async () => {
    const h = makeHarness();
    const fwd = await broker().openForward({ viewerUserId: "u-open", paneId: "p-fwd", nodeId: NODE, port: 8080 });
    await broker().openLaneForConnection(fwd.ref);
    await broker().startWatch({ viewerUserId: "u-watch", paneId: PANE, nodeId: NODE, port: 9222 });

    h.clock.now += PREVIEW_IDLE_MS;
    const closed = await broker().sweepIdle();
    await settle();
    expect(closed).toBe(1);
    expect(broker().sessionFor(fwd.ref)).toBeNull();
    expect(bridgeFor(PANE)).not.toBeNull(); // watched bridge: zero frames, zero closes
    const rows = await metadataOf("node.preview_forward.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paneId: "p-fwd", reason: "idle" });
    expect(await auditRows("node.preview_watch.close")).toHaveLength(0);
    // A wire close rode for the lane with the named reason (the session ref
    // was the probe, already closed on the node at open).
    expect(cmds(h, "preview_close").filter((c) => c.reason === "idle")).toHaveLength(1);
  });
});

describe("closeForPane and the node/user sweeps", () => {
  it("closeForPane(pane-gone) closes forward sessions, the bridge, and the display, auditing every pair", async () => {
    const h = makeHarness();
    const fwd = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    await broker().openLaneForConnection(fwd.ref);
    await broker().startWatch({ viewerUserId: "u-watch", paneId: PANE, nodeId: NODE, port: 9222 });
    broker().onDisplayOpened(NODE, PANE, SCREEN);
    const other = await broker().openForward({ viewerUserId: "u-open", paneId: "p-other", nodeId: NODE, port: 8081 });

    await broker().closeForPane(PANE, "pane-gone");
    await settle();
    expect(broker().sessionFor(fwd.ref)).toBeNull();
    expect(bridgeFor(PANE)).toBeNull();
    expect(broker().sessionFor(other.ref)).not.toBeNull(); // no bleed

    expect(await metadataOf("node.preview_forward.close")).toEqual([
      { paneId: PANE, nodeId: NODE, port: 8080, kind: "forward", reason: "pane-gone" },
    ]);
    expect((await metadataOf("node.preview_watch.close"))[0]).toMatchObject({ paneId: PANE, reason: "pane-gone" });
    expect((await metadataOf("node.preview_display.close"))[0]).toMatchObject({ paneId: PANE, reason: "pane-gone" });
    // Lane and bridge rode the wire with the named reason. The forward
    // SESSION adds no frame: its ref was the probe, already closed at open,
    // so the node holds live state only for the lane.
    expect(cmds(h, "preview_close").filter((c) => c.reason === "pane-gone")).toHaveLength(2);
  });

  it("closeAllForNode sweeps the node's sessions and display with node-dropped", async () => {
    const h = makeHarness();
    const mine = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    await broker().openLaneForConnection(mine.ref);
    broker().onDisplayOpened(NODE, PANE, SCREEN);
    const otherNode = await broker().openForward({
      viewerUserId: "u-open",
      paneId: "p-n2",
      nodeId: "n-different",
      port: 8080,
    });

    await broker().closeAllForNode(NODE, "node-dropped");
    await settle();
    expect(broker().sessionFor(mine.ref)).toBeNull();
    expect(broker().sessionFor(otherNode.ref)).not.toBeNull();
    const rows = await metadataOf("node.preview_forward.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paneId: PANE, nodeId: NODE, reason: "node-dropped" });
    expect((await metadataOf("node.preview_display.close"))[0]).toMatchObject({ paneId: PANE, reason: "node-dropped" });
    // The lane frame (the session ref was the probe, closed at open).
    expect(cmds(h, "preview_close").filter((c) => c.reason === "node-dropped")).toHaveLength(1);
  });

  it("closeAllForUser sweeps the user's forwards, watch counts, and held streams with revoked", async () => {
    const h = makeHarness();
    const theirs = await broker().openForward({ viewerUserId: "u-victim", paneId: PANE, nodeId: NODE, port: 8080 });
    await broker().openLaneForConnection(theirs.ref);
    const mine = await broker().openForward({
      viewerUserId: "u-bystander",
      paneId: "p-other",
      nodeId: NODE,
      port: 8080,
    });
    // Their watch count on a bridge someone else started: it decrements out,
    // and the bridge lives on under its remaining watcher.
    await broker().startWatch({ viewerUserId: "u-bystander", paneId: "p-shared", nodeId: NODE, port: 9222 });
    await broker().startWatch({ viewerUserId: "u-victim", paneId: "p-shared", nodeId: NODE, port: 9222 });
    // Their stream socket on a bridge they did not create.
    await broker().startWatch({ viewerUserId: "u-holder", paneId: "p-stream", nodeId: NODE, port: 9222 });
    broker().attachStream("p-stream", "k-v", "u-victim", fakeSocket());

    await broker().closeAllForUser("u-victim", "revoked");
    await settle();
    expect(broker().sessionFor(theirs.ref)).toBeNull();
    expect(broker().sessionFor(mine.ref)).not.toBeNull();
    const shared = bridgeFor("p-shared");
    expect(shared).not.toBeNull();
    expect(shared?.viewers.has("u-victim")).toBe(false);
    expect(shared?.viewers.get("u-bystander")).toBe(1);
    // The victim's stream socket is detached, never closed: frames stop.
    const streamBridge = bridgeFor("p-stream");
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(String(streamBridge?.ref), 1));
    expect(h.delivered).toHaveLength(0);
    const rows = await metadataOf("node.preview_forward.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paneId: PANE, reason: "revoked" });
    void h;
  });
});

describe("getPorts: the 5 second cache and the screenLost marker", () => {
  it("joins a scan already on its way instead of starting a second sweep", async () => {
    // The cache only fills on completion, and a probe sweep can take seconds on a
    // crowded pane, so without this the header poll and an opened picker each
    // fire their own sweep at the node, and the later one can overwrite the cache
    // with a less complete rotation.
    let rpcs = 0;
    let release: (() => void) | undefined;
    makeHarness({
      ack: (cmd) => {
        if (cmd.type !== "preview_ports_get") return {};
        rpcs += 1;
        const answer = portsAnswer();
        // Held open until the test says so: this is the window a second reader
        // must ride along in rather than duplicate.
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return gate.then(() => answer);
      },
    });
    const first = broker().getPorts(NODE, PANE);
    const second = broker().getPorts(NODE, PANE);
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(rpcs).toBe(1);
    expect(a).toEqual(b);
  });

  it("caches for the window per pane, then re-RPCs", async () => {
    let rpcs = 0;
    makeHarness({
      ack: (cmd) => {
        if (cmd.type === "preview_ports_get") {
          rpcs += 1;
          return portsAnswer();
        }
        return {};
      },
    });
    await broker().getPorts(NODE, PANE);
    await broker().getPorts(NODE, PANE);
    expect(rpcs).toBe(1);
    // Per-pane key: a different pane is a different cache slot.
    await broker().getPorts(NODE, "p-other");
    expect(rpcs).toBe(2);
  });

  it("the cached answer carries screenLost through, marker and all", async () => {
    let rpcs = 0;
    makeHarness({
      ack: (cmd) => {
        if (cmd.type === "preview_ports_get") {
          rpcs += 1;
          return { ...portsAnswer(), screenLost: "x11vnc" as const };
        }
        return {};
      },
    });
    const first = await broker().getPorts(NODE, PANE);
    expect(first.screenLost).toBe("x11vnc");
    const second = await broker().getPorts(NODE, PANE);
    expect(second.screenLost).toBe("x11vnc");
    expect(rpcs).toBe(1);
  });

  it("no screenLost key at all when the RPC answer carried none (absent, never null)", async () => {
    makeHarness({
      ack: (cmd) => (cmd.type === "preview_ports_get" ? portsAnswer() : {}),
    });
    const answer = await broker().getPorts(NODE, PANE);
    expect("screenLost" in answer).toBe(false);
    const cached = await broker().getPorts(NODE, PANE);
    expect("screenLost" in cached).toBe(false);
  });

  it("a node refusal rejects named and caches NOTHING; a malformed answer rejects", async () => {
    let rpcs = 0;
    makeHarness({
      ack: (cmd) => {
        if (cmd.type === "preview_ports_get") {
          rpcs += 1;
          if (rpcs === 1) throw new NodeRpcError("offline", "down", NODE);
          return { not: "a ports answer" };
        }
        return {};
      },
    });
    await expect(broker().getPorts(NODE, PANE)).rejects.toBeInstanceOf(NodeRpcError);
    await expect(broker().getPorts(NODE, PANE)).rejects.toBeInstanceOf(Error);
    expect(rpcs).toBe(2); // neither failure left a cache entry
  });
});

describe("display memory: onDisplayOpened / onDisplayClosed", () => {
  it("audits open with {display, rfbPort} and close with the reason; double-close is idempotent", async () => {
    makeHarness();
    broker().onDisplayOpened(NODE, PANE, SCREEN);
    const opens = await metadataOf("node.preview_display.open");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toEqual({ paneId: PANE, nodeId: NODE, display: ":7", viewer: { protocol: "vnc", port: 5900 } });

    await broker().onDisplayClosed(PANE, "pane-gone");
    const closes = await metadataOf("node.preview_display.close");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ paneId: PANE, reason: "pane-gone" });

    await broker().onDisplayClosed(PANE, "idle");
    expect(await metadataOf("node.preview_display.close")).toHaveLength(1);
    // And a close for a pane with no display record audits nothing either.
    await broker().onDisplayClosed("p-never-opened", "pane-gone");
    expect(await metadataOf("node.preview_display.close")).toHaveLength(1);
  });
});

describe("closeUnauthorizedForPane: the recompute, one case per transition", () => {
  function accessMap(map: Record<string, Access>) {
    return async (userId: string, paneId: string): Promise<Access> => map[`${userId}@${paneId}`] ?? "none";
  }

  it("an edit->view DOWNGRADE closes the grantee's forward session (lanes in, revoked) and keeps their watch streaming", async () => {
    const h = makeHarness({ cdpPort: 9222, accessFor: accessMap({ "u-owner@p1": "owner", "u-grantee@p1": "view" }) });
    const fwd = await broker().openForward({ viewerUserId: "u-grantee", paneId: "p1", nodeId: NODE, port: 8080 });
    await broker().openLaneForConnection(fwd.ref);
    await broker().startWatch({ viewerUserId: "u-grantee", paneId: "p1", nodeId: NODE, port: 9222 });
    broker().attachStream("p1", "k-g", "u-grantee", fakeSocket());

    await broker().closeUnauthorizedForPane("p1");
    await settle();

    expect(broker().sessionFor(fwd.ref)).toBeNull();
    const rows = await metadataOf("node.preview_forward.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paneId: "p1", reason: "revoked" });
    // The view tier they still hold: watch count, bridge, and socket untouched.
    const bridge = bridgeFor("p1");
    expect(bridge).not.toBeNull();
    expect(bridge?.viewers.get("u-grantee")).toBe(1);
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(String(bridge?.ref), 1));
    expect(h.delivered).toHaveLength(1);
    expect(await auditRows("node.preview_watch.close")).toHaveLength(0);
    expect(cmds(h, "preview_close").filter((c) => c.reason === "revoked")).toHaveLength(1); // the lane
  });

  it("a full removal sweeps BOTH tiers, empties the bridge to zero with revoked, and never closes the socket", async () => {
    const h = makeHarness({ accessFor: accessMap({ "u-owner@p1": "owner", "u-stranger@p1": "none" }) });
    const fwd = await broker().openForward({ viewerUserId: "u-stranger", paneId: "p1", nodeId: NODE, port: 8080 });
    await broker().startWatch({ viewerUserId: "u-stranger", paneId: "p1", nodeId: NODE, port: 9222 });
    const socket = fakeSocket();
    broker().attachStream("p1", "k-s", "u-stranger", socket);

    await broker().closeUnauthorizedForPane("p1");
    await settle();
    expect(broker().sessionFor(fwd.ref)).toBeNull();
    expect(bridgeFor("p1")).toBeNull();
    const closes = await metadataOf("node.preview_watch.close");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ paneId: "p1", reason: "revoked" }); // not viewer-left

    // A NEW owner-run bridge proves the revoked holder's socket is gone from
    // the pane's attach set while the socket object itself was never closed
    // (the /ws/live feed outlives a single lost grant).
    await broker().startWatch({ viewerUserId: "u-owner", paneId: "p1", nodeId: NODE, port: 9222 });
    const survivor = fakeSocket();
    broker().attachStream("p1", "k-o", "u-owner", survivor);
    h.delivered.length = 0;
    broker().onStreamEvent(NODE, streamEvent(String(bridgeFor("p1")?.ref), 1));
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.socket).toBe(survivor);
  });

  it("the Everyone row's edit->view write closes every non-owner forward session; the owner's and a still-edit grantee's sit untouched", async () => {
    makeHarness({
      accessFor: accessMap({
        "u-owner@p1": "owner",
        "u-downgraded@p1": "view",
        "u-still-edit@p1": "edit",
      }),
    });
    const owner = await broker().openForward({ viewerUserId: "u-owner", paneId: "p1", nodeId: NODE, port: 8080 });
    const downgraded = await broker().openForward({
      viewerUserId: "u-downgraded",
      paneId: "p1",
      nodeId: NODE,
      port: 8081,
    });
    const stillEdit = await broker().openForward({
      viewerUserId: "u-still-edit",
      paneId: "p1",
      nodeId: NODE,
      port: 8082,
    });

    await broker().closeUnauthorizedForPane("p1");
    await settle();
    expect(broker().sessionFor(owner.ref)).not.toBeNull();
    expect(broker().sessionFor(stillEdit.ref)).not.toBeNull();
    expect(broker().sessionFor(downgraded.ref)).toBeNull();
    expect(await metadataOf("node.preview_forward.close")).toHaveLength(1);
  });

  it("a view->edit UPGRADE closes nothing (the recompute fires on every shares write, even widening ones)", async () => {
    const h = makeHarness({ accessFor: accessMap({ "u-up@p1": "edit" }) });
    const fwd = await broker().openForward({ viewerUserId: "u-up", paneId: "p1", nodeId: NODE, port: 8080 });
    await broker().startWatch({ viewerUserId: "u-up", paneId: "p1", nodeId: NODE, port: 9222 });
    broker().attachStream("p1", "k-u", "u-up", fakeSocket());

    await broker().closeUnauthorizedForPane("p1");
    await settle();
    expect(broker().sessionFor(fwd.ref)).not.toBeNull();
    expect(bridgeFor("p1")).not.toBeNull();
    // Nothing beyond the open's probe close: the sweep closes nothing on a
    // widening write.
    expect(cmds(h, "preview_close").filter((c) => c.ref !== fwd.ref)).toHaveLength(0);
    expect(await auditRows("node.preview_forward.close")).toHaveLength(0);
    expect(await auditRows("node.preview_watch.close")).toHaveLength(0);
  });

  it("no transition reaches a different pane's sessions", async () => {
    const h = makeHarness({ accessFor: async () => "none" });
    const other = await broker().openForward({
      viewerUserId: "u-gone",
      paneId: "p-elsewhere",
      nodeId: NODE,
      port: 8080,
    });
    await broker().openForward({ viewerUserId: "u-gone", paneId: "p1", nodeId: NODE, port: 8080 });

    await broker().closeUnauthorizedForPane("p1");
    await settle();
    expect(broker().sessionFor(other.ref)).not.toBeNull();
    expect(h.accessCalls.every((c) => c.paneId === "p1")).toBe(true);
  });
});

describe("the shares write performs the cut (real SubshellsService.setShares)", () => {
  it("setShares fires closeUnauthorizedForPane: the downgraded grantee's forward session closes revoked", async () => {
    const ctx = getRequestlessContext();
    const service = new SubshellsService({ db: ctx.db, log: getLogger(), repos: ctx.repos });
    const paneId = crypto.randomUUID();
    const owner = "u-shares-owner";
    const grantee = "u-shares-grantee";
    // setShares validates every grantee against the users table for real (the
    // access seam fakes only the revocation recompute), so both principals
    // must exist as rows.
    for (const id of [owner, grantee]) {
      await sql`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
                VALUES (${id}, ${id}, ${`${id}@example.test`}, 1, datetime('now'), datetime('now'))`.execute(db);
    }
    await ctx.repos.subshells.create({
      id: paneId,
      userId: owner,
      harnessId: "terminal",
      name: "preview shares row",
      workingDir: "/tmp",
      tmuxSocket: `subshell-${paneId.slice(0, 8)}`,
      status: "running",
      alive: 1,
      nodeId: "n-preview",
      ssh: null,
    });
    // The fake answers the POST-WRITE access (the row is already replaced):
    // the grantee resolves to `view`, under the forward tier they hold.
    const h = makeHarness({
      accessFor: async (userId) => (userId === owner ? "owner" : userId === grantee ? "view" : "none"),
    });
    const fwd = await broker().openForward({ viewerUserId: grantee, paneId, nodeId: "n-preview", port: 8080 });
    await broker().openLaneForConnection(fwd.ref);

    const entries: ShareEntry[] = [{ granteeUserId: grantee, permission: "view" }];
    await service.setShares(owner, paneId, entries, "cookie");
    await settle();

    expect(broker().sessionFor(fwd.ref)).toBeNull();
    const rows = await metadataOf("node.preview_forward.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paneId, reason: "revoked" });
    expect(h.sent.some((c) => c.cmd.type === "preview_close" && c.cmd.reason === "revoked")).toBe(true);
    await ctx.repos.subshells.delete(paneId).catch(() => {});
  });
});

describe("concurrency: synchronous reservations and the one-bridge-per-pane edge (review 2026-10-23)", () => {
  it("pane at three lanes: two concurrent opens send the node ONE lane open; the second queues and a close promotes it", async () => {
    let probeRef = "";
    let holdLanes = false;
    const h = makeHarness({
      hold: (cmd) => holdLanes && cmd.type === "preview_open" && cmd.kind === "forward" && cmd.ref !== probeRef,
    });
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    probeRef = ref;
    const lanes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const lane = await broker().openLaneForConnection(ref);
      lanes.push(lane.laneRef);
    }
    holdLanes = true;

    const pA = broker().openLaneForConnection(ref);
    const pB = broker().openLaneForConnection(ref);
    await settle();
    // Exactly ONE open in flight (A's, held). B reserved its slot
    // synchronously and queued without ever reaching the node: two opens in
    // `held` would mean both calls passed the check before either registered.
    expect(h.held).toHaveLength(1);

    releaseHeld(h); // A's ack lands; A owns the fourth slot
    await expect(pA).resolves.toMatchObject({ laneRef: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(h.held).toHaveLength(0); // B is queued, not flying

    // Closing one lane frees the slot AND promotes B: its open is now the
    // one in flight. The close itself awaits the promoted open (dequeue runs
    // inside the release), so the release comes before awaiting the close.
    const closing = broker().closeLaneForConnection(lanes[0], "viewer-left");
    await settle();
    expect(h.held).toHaveLength(1);
    releaseHeld(h);
    await closing;
    await expect(pB).resolves.toMatchObject({ laneRef: expect.stringMatching(/^[0-9a-f]{32}$/) });
    // Exactly four live lanes and an empty queue: six lane-shaped opens ever
    // reached the node (probe + three + A + B), and a seventh caller cannot
    // sneak one past: it queues without touching the wire.
    const extra = broker().openLaneForConnection(ref);
    extra.catch(() => {}); // the reset shutdown will reject it; that is this test's own teardown
    await settle();
    expect(h.held).toHaveLength(0);
    expect(cmds(h, "preview_open").filter((c) => c.kind === "forward")).toHaveLength(6);
  });

  it("two concurrent startWatch on a cold pane: ONE preview_open reaches the node, both callers resolve ok, ONE close follows two stops", async () => {
    const h = makeHarness({ hold: (cmd) => cmd.type === "preview_open" && cmd.kind === "screencast" });
    const p1 = broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    const p2 = broker().startWatch({ viewerUserId: "u-a", paneId: PANE, nodeId: NODE, port: 9222 });
    await settle();
    // One cold open per pane, ever: the second caller awaits the winner. Two
    // held opens here is the orphan bridge (loser registered nowhere
    // reachable, uncounted by sweepIdle) the review named.
    expect(h.held).toHaveLength(1);
    expect(cmds(h, "preview_open").filter((c) => c.kind === "screencast")).toHaveLength(1);
    releaseHeld(h);
    await expect(p1).resolves.toEqual({ ok: true });
    await expect(p2).resolves.toEqual({ ok: true });
    const bridge = String(bridgeFor(PANE)?.ref);
    expect(bridge).toMatch(/^[0-9a-f]{32}$/);
    expect(bridgeFor(PANE)?.viewers.get("u-a")).toBe(2); // the joiner incremented the SAME bridge
    expect(await metadataOf("node.preview_watch.open")).toHaveLength(1); // not one row per caller

    await broker().stopWatch("u-a", PANE);
    await broker().stopWatch("u-a", PANE);
    const closes = cmds(h, "preview_close").filter((c) => c.ref === bridge);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ reason: "viewer-left" });
  });

  it("a refused lane open releases its reservation, and the freed slot still promotes the queued waiter", async () => {
    let probeRef = "";
    let holdLanes = false;
    const h = makeHarness({
      hold: (cmd) => holdLanes && cmd.type === "preview_open" && cmd.kind === "forward" && cmd.ref !== probeRef,
    });
    const { ref } = await broker().openForward({ viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 });
    probeRef = ref;
    for (let i = 0; i < 3; i += 1) await broker().openLaneForConnection(ref);
    holdLanes = true;

    const pA = broker().openLaneForConnection(ref);
    const pB = broker().openLaneForConnection(ref);
    await settle();
    expect(h.held).toHaveLength(1); // B is queued behind A's reservation

    // A's node-side refusal must release the reservation through the lane
    // close path: the slot frees and B is promoted at once. A's rejection
    // waits on B's open behind it (the release chain runs the promotion), so
    // both held acks are answered before awaiting either caller.
    refuseHeld(h, new NodeRpcError("failed", "refused", NODE, "preview-sessions-exhausted"));
    await settle();
    expect(h.held).toHaveLength(1); // B's promoted open, in flight
    releaseHeld(h);
    await expect(pA).rejects.toBeInstanceOf(NodeRpcError);
    await expect(pB).resolves.toMatchObject({ laneRef: expect.stringMatching(/^[0-9a-f]{32}$/) });
    // No phantom lane holds a slot: A's refused reservation left nothing
    // behind (probe + three + A's refusal + B's promotion = six forward opens
    // ever sent, four of them live), so the next caller simply queues with
    // no wire activity.
    expect(cmds(h, "preview_open").filter((c) => c.kind === "forward")).toHaveLength(6);
    const extra = broker().openLaneForConnection(ref);
    extra.catch(() => {}); // the reset shutdown will reject it; that is this test's own teardown
    await settle();
    expect(h.held).toHaveLength(0);
  });
});

describe("revocation during a preview open", () => {
  it("removing a saved service cancels its pending open before a late node acknowledgement", async () => {
    const h = makeHarness({ hold: (cmd) => cmd.type === "preview_open" });
    const b = getPreviewBroker();
    const service = { host: "example.com", protocol: "https" } as const;
    const opening = b
      .openForward({ viewerUserId: "u-race", paneId: PANE, nodeId: NODE, port: 443, serviceId: "saved", service })
      .then(
        () => "opened",
        () => "refused",
      );
    await settle();
    expect(h.held).toHaveLength(1);
    const command = cmds(h, "preview_open")[0];
    expect(command?.service).toEqual(service);
    await b.removeService(PANE, "saved");
    releaseHeld(h);
    expect(await opening).toBe("refused");
    expect(b.sessionFor(command.ref)).toBeNull();
  });
  for (const kind of ["forward", "screencast"] as const) {
    for (const revoke of ["pane", "node", "account", "share"] as const) {
      it(`${revoke} revocation cancels a pending ${kind} before its late acknowledgement`, async () => {
        const h = makeHarness({ hold: (cmd) => cmd.type === "preview_open", accessFor: async () => "none" });
        const b = getPreviewBroker();
        const input = { viewerUserId: "u-race", paneId: PANE, nodeId: NODE, port: 8080 };
        const opening = (kind === "forward" ? b.openForward(input) : b.startWatch(input)).then(
          () => "opened",
          () => "refused",
        );
        await settle();
        expect(h.held).toHaveLength(1);
        const ref = cmds(h, "preview_open")[0]?.ref;
        if (!ref) throw new Error("Missing pending ref");
        if (revoke === "pane") await b.closeForPane(PANE, "pane-gone");
        if (revoke === "node") await b.closeAllForNode(NODE, "node-dropped");
        if (revoke === "account") await b.closeAllForUser("u-race", "revoked");
        if (revoke === "share") await b.closeUnauthorizedForPane(PANE);
        releaseHeld(h);
        expect(await opening).toBe("refused");
        expect(b.sessionFor(ref)).toBeNull();
        expect(cmds(h, "preview_close").some((cmd) => cmd.ref === ref)).toBe(true);
      });
    }
  }
});

describe("preview authorization at publication", () => {
  for (const kind of ["forward", "screencast"] as const) {
    it(`rechecks authorization before publishing a ${kind} that already reached the node`, async () => {
      const h = makeHarness({ hold: (cmd) => cmd.type === "preview_open" });
      let allowed = true;
      let checks = 0;
      const input = {
        viewerUserId: "u-race",
        paneId: PANE,
        nodeId: NODE,
        port: 8080,
        authorize: async () => {
          checks++;
          if (!allowed) throw new Error("access removed");
        },
      };
      const b = getPreviewBroker();
      const outcome = (kind === "forward" ? b.openForward(input) : b.startWatch(input)).then(
        () => "opened",
        () => "refused",
      );
      await settle();
      expect(h.held).toHaveLength(1);
      allowed = false;
      const ref = cmds(h, "preview_open")[0]?.ref;
      if (!ref) throw new Error("Missing ref");
      releaseHeld(h);
      expect(await outcome).toBe("refused");
      expect(checks).toBe(2);
      expect(b.sessionFor(ref)).toBeNull();
      expect(cmds(h, "preview_close").some((cmd) => cmd.ref === ref)).toBe(true);
    });
  }
});

it("retries authorization when a share sweep overtakes its permission read", async () => {
  makeHarness({ accessFor: async () => "view" });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const b = broker();
  const result = b
    .startWatch({
      viewerUserId: "u-race",
      paneId: PANE,
      nodeId: NODE,
      port: 9333,
      authorize: async () => {
        reads++;
        if (reads === 2) await gate; // stale editor answer after the node opened
        if (reads > 2) throw new Error("port no longer allowed");
      },
    })
    .then(
      () => "opened",
      () => "refused",
    );
  await settle();
  expect(reads).toBe(2);
  await b.closeUnauthorizedForPane(PANE);
  release();
  expect(await result).toBe("refused");
  expect(reads).toBe(3);
});

describe("uncertain preview opens", () => {
  for (const failure of ["timeout", "malformed"] as const) {
    for (const kind of ["probe", "bridge", "lane"] as const) {
      it(`closes the allocated ref after a ${failure} ${kind} acknowledgement`, async () => {
        let failOpen = false;
        const h = makeHarness({
          ack: (cmd) => {
            if (cmd.type === "preview_ports_get") return { ports: [], cdpPort: null, screen: null };
            if (cmd.type === "preview_close") return { ref: cmd.ref, closed: true };
            if (cmd.type === "preview_open") {
              if (failOpen) {
                if (failure === "timeout") throw new NodeRpcError("timeout", "late node", NODE);
                return {};
              }
              return { ref: cmd.ref, pending: true };
            }
            throw new Error("unexpected command");
          },
        });
        const input = { viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 };
        const session = kind === "lane" ? await broker().openForward(input) : null;
        const sentBefore = h.sent.length;
        failOpen = true;
        const result =
          kind === "lane"
            ? broker().openLaneForConnection(session?.ref ?? "")
            : kind === "bridge"
              ? broker().startWatch(input)
              : broker().openForward(input);
        await expect(result).rejects.toBeInstanceOf(Error);
        const sent = h.sent.slice(sentBefore).map((entry) => entry.cmd);
        const open = sent.find((cmd) => cmd.type === "preview_open");
        expect(open).toBeDefined();
        expect(sent.some((cmd) => cmd.type === "preview_close" && cmd.ref === open?.ref)).toBe(true);
      });
    }
  }
});

describe("preview capability capacity", () => {
  it("bounds retained forwarding capabilities even when they have no active lane", async () => {
    makeHarness();
    const input = { viewerUserId: "u-open", paneId: PANE, nodeId: NODE, port: 8080 };
    for (let i = 0; i < 64; i++) await broker().openForward(input);
    await expect(broker().openForward(input)).rejects.toMatchObject({ code: "preview-session-over-cap" });
    await broker().closeForPane(PANE, "pane-gone");
    await expect(broker().openForward(input)).resolves.toHaveProperty("ref");
  });
  it("bounds pending authorization before any node resource exists", async () => {
    makeHarness();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = {
      viewerUserId: "u-open",
      paneId: PANE,
      nodeId: NODE,
      port: 8080,
      authorize: async () => {
        await gate;
      },
    };
    const pending = Array.from({ length: 32 }, () => broker().openForward(input));
    try {
      await expect(broker().openForward(input)).rejects.toMatchObject({ code: "preview-session-over-cap" });
    } finally {
      release();
      await Promise.all(pending);
    }
  });
});
