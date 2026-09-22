import { describe, expect, it } from "bun:test";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { refireInputHoldsForNode } from "@/ws/input-hold.js";
import { inputWindowHas } from "@/ws/input-window.js";
import { cleanupSubshellWs, handleSubshellMessage } from "@/ws/subshell-ws.js";
import { registerViewer, resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";

/**
 * The plane→node input hold (spec 2026-09-21 Wave D): a failed write is held
 * per attached browser session and re-fired through the node's launcher when
 * the node's connection is live again — in id order, before anything newer,
 * exactly once per id.
 */

const NODE = "node-hold";

/**
 * One attached browser session against a launcher that rejects every input
 * write until `setHealthy(true)` turns it into a recording stub. The
 * shape mirrors subshell-ws.test.ts's fakeSocket, plus the `nodeId` and the
 * healthy flag the hold path needs.
 */
function fakeSession(opts: { subshellId?: string; sid?: string; nodeId?: string } = {}) {
  const subshellId = opts.subshellId ?? "s-hold";
  const inputs: string[] = [];
  let healthy = false;
  const launcher = {
    sendInput: async (_socket: string, _id: string, input: string) => {
      if (!healthy) throw new Error(`node "${opts.nodeId ?? NODE}" has no live connection`);
      inputs.push(input);
    },
    resize: async () => undefined,
    paneSize: async () => null,
  } as unknown as NodeLauncher;
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    data: {
      launcher,
      socket: "sock",
      subshellId,
      nodeId: opts.nodeId ?? NODE,
      logFile: "",
      canInput: true,
      viewerId: crypto.randomUUID(),
      deviceLabel: "Test device",
      since: new Date().toISOString(),
      // The attach session rides the upgrade query (`&sid=`), which the
      // adapter spread onto ws.data — the same channel the handler reads.
      query: { sid: opts.sid ?? "sess-1" },
    },
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
    close: () => undefined,
  } as unknown as WsSocket;
  registerViewer(ws, subshellId);
  return {
    ws,
    inputs,
    sent,
    subshellId,
    /** Sends one id'd input frame as the client would. */
    type: (data: string, id: number) => handleSubshellMessage(ws, JSON.stringify({ type: "input", data, id })),
    setHealthy: (v: boolean) => {
      healthy = v;
    },
  };
}

const acks = (sent: Array<Record<string, unknown>>) => sent.filter((f) => f.type === "ack");
/** Lets the drain's awaited writes settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

describe("plane→node input hold (Wave D)", () => {
  it("holds failed writes and re-fires them in id order when the node returns", async () => {
    const s = fakeSession({ subshellId: "hold-order" });
    for (let id = 1; id <= 5; id++) s.type(`k${id}`, id);
    await settle();
    expect(s.inputs).toEqual([]); // node down: nothing written
    expect(acks(s.sent)).toEqual([]); // and nothing acked
    s.setHealthy(true);
    refireInputHoldsForNode(NODE);
    await settle();
    // Every id fired, in id order, EXACTLY once — a re-fire is a retry of the
    // original write, not a replay of the queue.
    expect(s.inputs).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(acks(s.sent).map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    for (let id = 1; id <= 5; id++) {
      expect(inputWindowHas(s.subshellId, "sess-1", id)).toBe(true);
    }
  });

  it("later ids join the hold and re-fire after it, before anything newer", async () => {
    const s = fakeSession({ subshellId: "hold-join" });
    s.type("held", 16);
    await settle();
    expect(s.inputs).toEqual([]);
    // The wedge in the report: the client coalesces later keystrokes, so they
    // arrive AFTER the held id when the connection is restored.
    s.type("a", 17);
    s.type("b", 18);
    await settle();
    s.setHealthy(true);
    refireInputHoldsForNode(NODE);
    await settle();
    expect(s.inputs).toEqual(["held", "a", "b"]);
  });

  it("a healthy arrival while holds exist drains them first", async () => {
    // The append itself is a re-fire trigger: a backlog landing on a quietly
    // recovered node must ship immediately, not wait for a node-ready that
    // already happened.
    const s = fakeSession({ subshellId: "hold-arrival" });
    s.type("x", 1);
    await settle();
    s.setHealthy(true);
    s.type("y", 2);
    await settle();
    expect(s.inputs).toEqual(["x", "y"]);
    expect(acks(s.sent).map((f) => f.id)).toEqual([1, 2]);
  });

  it("a re-arriving id never duplicates a hold, and re-fires exactly once", async () => {
    const s = fakeSession({ subshellId: "hold-dup" });
    s.type("k", 1);
    await settle();
    // The client's reconnect re-send of the same id: same bytes, same id.
    s.type("k", 1);
    await settle();
    s.setHealthy(true);
    refireInputHoldsForNode(NODE);
    await settle();
    expect(s.inputs).toEqual(["k"]);
    expect(acks(s.sent)).toEqual([{ type: "ack", id: 1 }]);
    expect(inputWindowHas(s.subshellId, "sess-1", 1)).toBe(true);
  });

  it("a write that RESOLVED is committed before the ack, so a lost-ack re-send and a re-fire never double-write", async () => {
    // The ordering pin: the dedupe window takes the id the moment sendInput
    // resolves, BEFORE the ack frame is emitted. A result frame that reached
    // the plane but whose ack never reached the client therefore cannot
    // double-write — neither through the client's reconnect re-send nor
    // through a node-ready re-fire (a resolved write was never held).
    const s = fakeSession({ subshellId: "hold-resolved" });
    s.setHealthy(true);
    s.type("k", 1);
    await settle();
    expect(s.inputs).toEqual(["k"]);
    refireInputHoldsForNode(NODE);
    await settle();
    expect(s.inputs).toEqual(["k"]); // never held, never re-fired
    handleSubshellMessage(s.ws, JSON.stringify({ type: "input", data: "k", id: 1 }));
    await settle();
    expect(s.inputs).toEqual(["k"]); // the window absorbs the re-send
    expect(acks(s.sent).map((f) => f.id)).toEqual([1, 1]); // acked both times
  });

  it("a re-fire that fails re-enters the hold, and the next trigger writes it once", async () => {
    const s = fakeSession({ subshellId: "hold-refail" });
    s.type("k", 1);
    await settle();
    // First re-fire attempt still fails (the node came back and died again).
    refireInputHoldsForNode(NODE);
    await settle();
    expect(s.inputs).toEqual([]);
    // No retry timer: the frame waited for the NEXT trigger.
    s.setHealthy(true);
    refireInputHoldsForNode(NODE);
    await settle();
    expect(s.inputs).toEqual(["k"]);
    expect(acks(s.sent)).toEqual([{ type: "ack", id: 1 }]);
  });

  it("the hold dies with the browser session: cleanup drops it and a later node-ready writes nothing", async () => {
    const s = fakeSession({ subshellId: "hold-cleanup" });
    s.type("k", 1);
    await settle();
    cleanupSubshellWs(s.ws);
    s.setHealthy(true);
    refireInputHoldsForNode(NODE);
    await settle();
    expect(s.inputs).toEqual([]); // dropped with the session, not re-fired
    // The client's own safety net: its reconnect re-send writes the id, and
    // the new session is a fresh hold the old one cannot leak into.
    const fresh = fakeSession({ subshellId: "hold-cleanup" });
    fresh.setHealthy(true);
    fresh.type("k", 1);
    await settle();
    expect(fresh.inputs).toEqual(["k"]);
    expect(acks(fresh.sent)).toEqual([{ type: "ack", id: 1 }]);
  });

  it("a re-fire is scoped to the node that became reachable", async () => {
    const s = fakeSession({ subshellId: "hold-scope" });
    s.type("k", 1);
    await settle();
    s.setHealthy(true);
    refireInputHoldsForNode("some-other-node");
    await settle();
    expect(s.inputs).toEqual([]);
    refireInputHoldsForNode(NODE);
    await settle();
    expect(s.inputs).toEqual(["k"]);
  });

  it("local writes are never held: a failed local write keeps today's drop-and-log", async () => {
    const s = fakeSession({ subshellId: "hold-local", nodeId: LOCAL_NODE_ID });
    s.type("k", 1);
    await settle();
    s.setHealthy(true);
    refireInputHoldsForNode(LOCAL_NODE_ID);
    await settle();
    expect(s.inputs).toEqual([]); // no hold to re-fire
    expect(acks(s.sent)).toEqual([]);
    // The failed write stayed re-writable exactly as Wave A left it: the
    // client's re-send goes the normal path (not into a hold queue).
    s.type("k", 1);
    await settle();
    expect(s.inputs).toEqual(["k"]);
    expect(acks(s.sent)).toEqual([{ type: "ack", id: 1 }]);
  });

  it("sessions on one subshell never collide: holds are per session", async () => {
    const a = fakeSession({ subshellId: "hold-sessions", sid: "sess-a" });
    const b = fakeSession({ subshellId: "hold-sessions", sid: "sess-b" });
    a.type("a", 1);
    await settle();
    // b's id 1 is a DIFFERENT keystroke: it must not be absorbed into a's
    // hold, and the dedupe window must not swallow it either.
    b.setHealthy(true);
    b.type("b", 1);
    await settle();
    expect(b.inputs).toEqual(["b"]);
    a.setHealthy(true);
    refireInputHoldsForNode(NODE);
    await settle();
    expect(a.inputs).toEqual(["a"]);
  });

  it("resetLiveViewersForTests clears the holds", async () => {
    const s = fakeSession({ subshellId: "hold-reset" });
    s.type("k", 1);
    await settle();
    resetLiveViewersForTests();
    const fresh = fakeSession({ subshellId: "hold-reset" });
    fresh.setHealthy(true);
    fresh.type("k", 1);
    await settle();
    // A surviving hold would have queued the fresh case's id 1 as a duplicate
    // of the dead case's frame; a surviving window would have swallowed it.
    expect(fresh.inputs).toEqual(["k"]);
  });
});
