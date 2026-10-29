import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_FORWARD_SESSIONS_PER_PANE,
  PREVIEW_FRAME_MAX_BYTES,
  PREVIEW_SESSIONS_PER_NODE,
  type PreviewCloseReason,
  type PreviewOpenCommand,
  parseNodePreviewCloseResult,
  parseNodePreviewOpenResult,
} from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execPreviewClose } from "../commands/preview-close-exec.js";
import {
  PREVIEW_LANE_OVER_NODE_CAP,
  PREVIEW_LANE_OVER_PANE_CAP,
  PREVIEW_PANE_GONE,
} from "../commands/preview-open-exec.js";
import { PREVIEW_NODE_OFF } from "../commands/preview-ports-exec.js";
import { setPreviewEnabled } from "../preview/flags.js";
import { type LaneDeps, type LaneSocket, PreviewForward, type PreviewLaneEvent } from "../preview/forward.js";

/**
 * The forward-lane executor and registry (pane-preview spec 2026-10-21 §4/§6,
 * Task 5): the A-branch contract (register + ack synchronously, dial off the
 * chain, close-not-gated, tombstoned answer) copied from
 * commands-ssh-relay.test.ts, the byte pump copied from relay-send's
 * deliver-or-throw. Posture identical to that precedent: real temp dirs, the
 * preview mirror written by its own writer, refusals asserted by `ok:false` +
 * exact message.
 *
 * Every mechanics test injects the `LaneDeps` seam: a fake `connect` hands the
 * lane a FakeSocket it can drive (connect/data/end/error on demand), and a
 * FakeClock captures the idle/lifetime timers so the budget cases fire them by
 * hand instead of waiting out real 15-minute timers. Case (b) is the honest
 * one: a real echo server on an ephemeral loopback port, dialed by real net.
 */

const STAMP = "2026-10-21T10:00:00.000Z";
const PANES = [
  "11111111-2222-4333-8444-555555555555",
  "22222222-2222-4333-8444-555555555555",
  "33333333-2222-4333-8444-555555555555",
  "44444444-2222-4333-8444-555555555555",
  "55555555-2222-4333-8444-555555555555",
] as const;
const PANE = PANES[0];

/** 32 lowercase hex, valid against PREVIEW_REF_RE, unique per sequence number. */
const refFor = (n: number): string => n.toString(16).padStart(32, "0");

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-preview-forward-")));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* harness: fake sockets, fake clock, recording context               */
/* ------------------------------------------------------------------ */

type Timer = { cb: () => void; ms: number; cancelled: boolean; fired: boolean };

class FakeClock {
  timers: Timer[] = [];

  setTimeout(cb: () => void, ms: number): unknown {
    const t: Timer = { cb, ms, cancelled: false, fired: false };
    this.timers.push(t);
    return t;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "object" && handle !== null) (handle as Timer).cancelled = true;
  }

  /** Run every live timer scheduled at exactly `ms`; returns how many fired. */
  fire(ms: number): number {
    let n = 0;
    for (const t of this.timers) {
      if (!t.cancelled && !t.fired && t.ms === ms) {
        t.fired = true;
        n += 1;
        t.cb();
      }
    }
    return n;
  }

  liveAt(ms: number): number {
    return this.timers.filter((t) => !t.cancelled && !t.fired && t.ms === ms).length;
  }

  cancelledAt(ms: number): number {
    return this.timers.filter((t) => t.cancelled && t.ms === ms).length;
  }
}

class FakeSocket {
  private handlers = new Map<string, ((arg?: unknown) => void)[]>();
  writes: Buffer[] = [];
  destroyed = false;
  writableLength = 0;

  on(event: string, listener: (arg?: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  fire(event: string, arg?: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(arg);
  }

  write(chunk: Uint8Array | string): boolean {
    this.writes.push(Buffer.from(chunk));
    this.writableLength += Buffer.byteLength(chunk);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function makeHarness(
  tag: string,
  opts: { previewOn?: boolean; panePid?: number | null; deps?: LaneDeps } = {},
): {
  ctx: CommandContext;
  forward: PreviewForward;
  events: PreviewLaneEvent[];
  sockets: FakeSocket[];
  attempts: { host: string; port: number }[];
  clock: FakeClock;
} {
  const dataDir = join(base, tag, "data");
  mkdirSync(dataDir, { recursive: true });
  if (opts.previewOn ?? true) setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
  const events: PreviewLaneEvent[] = [];
  const sockets: FakeSocket[] = [];
  const attempts: { host: string; port: number }[] = [];
  const clock = new FakeClock();
  // Held-connect dials by default: lanes register and stay pending until the
  // test fires connect/error, so quota and close-all cases hold real lanes
  // without real sockets. `{ connect: undefined }` falls back to the module's
  // real net dial (case (b)).
  const forward = new PreviewForward({
    connect: ({ host, port }) => {
      const s = new FakeSocket();
      sockets.push(s);
      attempts.push({ host, port });
      return s as unknown as LaneSocket;
    },
    timer: clock,
    idleMs: 900_000,
    ...opts.deps,
  });
  const ctx = {
    config: { dataDir, nodeId: "node-self" },
    meta: { get: async () => undefined },
    tmux: { panePid: async () => (opts.panePid === undefined ? 100 : opts.panePid) },
    previewForward: forward,
    sendPreviewEvent: (ev: PreviewLaneEvent) => {
      events.push(ev);
    },
  } as unknown as CommandContext;
  return { ctx, forward, events, sockets, attempts, clock };
}

function openCmd(over: Partial<PreviewOpenCommand> = {}): PreviewOpenCommand {
  return {
    type: "preview_open",
    ref: refFor(1),
    kind: "forward",
    paneId: PANE,
    port: 4321,
    lifetimeMs: 60_000,
    ...over,
  };
}

/** Poll until `cond`, then return; a real wait for the real-socket case. */
async function waitUntil(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** True when this host can bind an IPv6 loopback listener (probed once at collect). */
const HAS_V6_LOOPBACK = await (async (): Promise<boolean> => {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "::1", () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
})();

const closeEvents = (events: PreviewLaneEvent[]): { ref: string; reason: PreviewCloseReason }[] =>
  events
    .filter((e): e is Extract<PreviewLaneEvent, { type: "preview_closed" }> => e.type === "preview_closed")
    .map((e) => ({ ref: e.ref, reason: e.reason }));

const dataEvents = (events: PreviewLaneEvent[]): Extract<PreviewLaneEvent, { type: "preview_data" }>[] =>
  events.filter((e): e is Extract<PreviewLaneEvent, { type: "preview_data" }> => e.type === "preview_data");

/* ------------------------------------------------------------------ */
/* (a) the A-branch contract: ack before the dial settles             */
/* ------------------------------------------------------------------ */

describe("(a) pending ack, off-chain dial (the ssh-relay A-branch contract)", () => {
  it("keeps full capability references out of runtime diagnostics", () => {
    const h = makeHarness("private-reference");
    const ref = "0123456789abcdef0123456789abcdef";
    const logs: string[] = [];
    h.forward.openLane({
      ref,
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60000,
      hooks: { emit: () => {}, log: (line) => logs.push(line) },
    });
    h.forward.closeLane(ref, "viewer-left");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((line) => !line.includes(ref))).toBe(true);
    expect(logs.some((line) => line.includes(ref.slice(0, 8)))).toBe(true);
  });
  it("acks immediately, unblocks the next command, and a failed dial emits target-gone once", async () => {
    const h = makeHarness("ack-offchain");
    const exec = dispatchCommand(h.ctx, openCmd());
    // The proof is timing (commands-ssh-relay.test.ts's habit): if the
    // executor awaited the dial, this race would answer `timeout`.
    const winner = await Promise.race([
      exec.then((r) => ({ kind: "ack" as const, r })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 100)),
    ]);
    expect(winner.kind).toBe("ack");
    if (winner.kind !== "ack") return;
    expect(winner.r).toEqual({ ok: true, data: { ref: refFor(1), pending: true } });
    // Task 1's validator accepts the forward ack shape.
    expect(parseNodePreviewOpenResult(winner.r.ok === true ? winner.r.data : null)).toEqual({
      ref: refFor(1),
      pending: true,
    });
    // A FOLLOWING command is not parked behind the pending dial: the ping
    // answers while the first attempt is still open (one attempt so far).
    const ping = await Promise.race([
      dispatchCommand(h.ctx, { type: "ping" }).then((r) => ({ kind: "pong" as const, r })),
      new Promise<{ kind: "blocked" }>((resolve) => setTimeout(() => resolve({ kind: "blocked" }), 100)),
    ]);
    expect(ping.kind).toBe("pong");
    expect(h.attempts).toEqual([{ host: "127.0.0.1", port: 4321 }]);

    // The eventual failure: v4 refused (a real connect failure is an `error`
    // THEN a guaranteed `close`), the ONE v6 retry refused the same way, and
    // the plane is told `target-gone` exactly once.
    h.sockets[0]?.fire("error", new Error("connect ECONNREFUSED 127.0.0.1:4321"));
    h.sockets[0]?.fire("close");
    expect(h.attempts.map((a) => a.host)).toEqual(["127.0.0.1", "::1"]);
    expect(h.forward.laneCount()).toBe(1); // the dead v4 dial's close must not end the retry
    h.sockets[1]?.fire("error", new Error("connect ECONNREFUSED ::1:4321"));
    h.sockets[1]?.fire("close");
    expect(closeEvents(h.events)).toEqual([{ ref: refFor(1), reason: "target-gone" }]);
    expect(h.forward.laneCount()).toBe(0);

    // A close of that ref after the death is the honest tombstone answer.
    expect(await dispatchCommand(h.ctx, { type: "preview_close", ref: refFor(1), reason: "viewer-left" })).toEqual({
      ok: true,
      data: { ref: refFor(1), closed: false },
    });
  });

  it("the v4 dial's close does not kill the v6 retry: error+close survives to a live ::1", () => {
    // The MAJOR-1 posture (Task 5 review): a real socket whose connect fails
    // emits `error` and then, on a nextTick, a guaranteed `close`. The close
    // lands AFTER the synchronous retry is in flight, and it must not be read
    // as the LANE dying (which would destroy the pending ::1 socket and emit
    // target-gone before the v6 handshake, precisely on the one-family server
    // the retry exists for).
    const h = makeHarness("retry-survives");
    h.forward.openLane({
      ref: refFor(1),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60_000,
      hooks: { emit: (ev) => h.events.push(ev) },
    });
    h.sockets[0]?.fire("error", new Error("connect ECONNREFUSED 127.0.0.1:4321"));
    expect(h.attempts.map((a) => a.host)).toEqual(["127.0.0.1", "::1"]); // retry already in flight
    h.sockets[0]?.fire("close"); // the dead v4 socket's own death notice
    expect(h.forward.laneCount()).toBe(1); // the lane lives
    expect(closeEvents(h.events)).toHaveLength(0); // and reports nothing
    expect(h.sockets[0]?.destroyed).toBe(true); // the superseded socket is released by the retry itself
    expect(h.sockets[1]?.destroyed).toBe(false); // the in-flight ::1 dial survives
    h.sockets[1]?.fire("connect");
    expect(h.forward.laneCount()).toBe(1);
    expect(h.events).toHaveLength(0);
  });

  // The end-to-end twin, real net on both legs (case (b)'s habit): a server
  // bound to ::1 ONLY, so the production dial must take its v4 refusal and
  // land on v6. A host without IPv6 loopback cannot represent this; the skip
  // says so out loud. The fake-sequence case above runs everywhere.
  it.skipIf(!HAS_V6_LOOPBACK)("a v6-only loopback server is reached through the real retry", async () => {
    const received: Buffer[] = [];
    let connected = false;
    const server = createServer((sock) => {
      sock.on("data", (d) => {
        received.push(Buffer.from(d));
        sock.write(d);
      });
    });
    server.once("connection", () => {
      connected = true;
    });
    await new Promise<void>((r) => server.listen(0, "::1", r));
    const port = (server.address() as AddressInfo).port;
    const h = makeHarness("v6-only", { deps: { connect: undefined } }); // real net, fake clock
    try {
      const res = await dispatchCommand(h.ctx, openCmd({ port }));
      expect(res.ok).toBe(true);
      // The v4 refusal (error then close) must ride out; stop at whichever
      // real event arrives first, so a pre-fix death reads as itself.
      await waitUntil(() => connected || closeEvents(h.events).length > 0, "the v6 dial or a lane death");
      expect(closeEvents(h.events)).toHaveLength(0);
      expect(connected).toBe(true);
      expect(h.forward.laneCount()).toBe(1);
      await new Promise((r) => setTimeout(r, 50)); // let any late v4 socket close land
      expect(h.forward.laneCount()).toBe(1);
      expect(closeEvents(h.events)).toHaveLength(0);
      h.forward.ingestInboundFrame({
        type: "preview_data",
        ref: refFor(1),
        dir: "in",
        blob: Buffer.from("ping").toString("base64"),
      });
      await waitUntil(() => dataEvents(h.events).length >= 1, "the echoed bytes back on the v6 lane");
      expect(Buffer.concat(received).toString()).toBe("ping");
    } finally {
      h.forward.closeAll("viewer-left");
      server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* (b) a real connected lane echoes both directions                    */
/* ------------------------------------------------------------------ */

describe("(b) the connected lane pumps both directions", () => {
  it("an inbound preview_data reaches the socket and echoed bytes leave as an out event", async () => {
    const received: Buffer[] = [];
    const server = createServer((sock) => {
      sock.on("data", (d) => {
        received.push(Buffer.from(d));
        sock.write(d);
      });
    });
    const dialed = new Promise<void>((resolve) => server.once("connection", () => resolve()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const h = makeHarness("echo", { deps: { connect: undefined } }); // real net, fake clock
    try {
      const res = await dispatchCommand(h.ctx, openCmd({ port }));
      expect(res.ok).toBe(true);
      await dialed;
      h.forward.ingestInboundFrame({
        type: "preview_data",
        ref: refFor(1),
        dir: "in",
        blob: Buffer.from("ping").toString("base64"),
      });
      await waitUntil(() => dataEvents(h.events).length >= 1, "the echoed bytes leave as an out event");
      expect(Buffer.concat(received).toString()).toBe("ping");
      expect(dataEvents(h.events)[0]).toEqual({
        type: "preview_data",
        ref: refFor(1),
        dir: "out",
        blob: Buffer.from("ping").toString("base64"),
      });
    } finally {
      h.forward.closeAll("viewer-left");
      server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* (c) close is not gated; unknown refs answer the tombstone           */
/* ------------------------------------------------------------------ */

describe("(c) preview_close is teardown, not a gated act", () => {
  it("an off switch does not refuse a close: an unknown ref answers closed:false", async () => {
    const h = makeHarness("close-ungated", { previewOn: false });
    const res = await execPreviewClose(h.ctx, { type: "preview_close", ref: refFor(7), reason: "viewer-left" });
    expect(res).toEqual({ ok: true, data: { ref: refFor(7), closed: false } });
    expect(parseNodePreviewCloseResult(res.ok === true ? res.data : null)).toEqual({
      ref: refFor(7),
      closed: false,
    });
  });

  it("closing an owned lane destroys its socket, answers closed:true, and emits NO event", () => {
    const h = makeHarness("close-owned");
    h.forward.openLane({
      ref: refFor(1),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60_000,
      hooks: { emit: (ev) => h.events.push(ev) },
    });
    h.sockets[0]?.fire("connect");
    expect(h.forward.closeLane(refFor(1), "viewer-left")).toEqual({ closed: true });
    expect(h.sockets[0]?.destroyed).toBe(true);
    expect(h.forward.laneCount()).toBe(0);
    // The plane ordered this death; it does not need the node to report it.
    expect(h.events).toHaveLength(0);
    // The idempotent twin: a second close answers closed:false.
    expect(h.forward.closeLane(refFor(1), "viewer-left")).toEqual({ closed: false });
  });
});

/* ------------------------------------------------------------------ */
/* (d) quotas: 16 per node, 4 per pane (lanes only, this task)         */
/* ------------------------------------------------------------------ */

describe("(d) the node-side budgets", () => {
  it("the 17th concurrent lane refuses node-cap; the 5th in one pane refuses pane-cap", async () => {
    expect(PREVIEW_SESSIONS_PER_NODE).toBe(16);
    expect(PREVIEW_FORWARD_SESSIONS_PER_PANE).toBe(4);
    const h = makeHarness("quota");
    let n = 0;
    const openIn = async (paneId: string) => {
      n += 1;
      return await dispatchCommand(h.ctx, openCmd({ ref: refFor(n), paneId }));
    };
    for (const paneId of [PANES[0], PANES[1], PANES[2], PANES[3]]) {
      for (let i = 0; i < PREVIEW_FORWARD_SESSIONS_PER_PANE; i += 1) expect((await openIn(paneId)).ok).toBe(true);
    }
    expect(h.forward.laneCount()).toBe(16);
    expect(h.forward.laneCount(PANES[0])).toBe(4);
    // The 17th lands in a fresh pane: the pane gate passes, the node gate refuses.
    expect(await openIn(PANES[4])).toEqual({ ok: false, error: PREVIEW_LANE_OVER_NODE_CAP });
    expect(h.forward.laneCount()).toBe(16);
    // Free one node slot, refill pane A to its cap, then ask for its 5th:
    // the per-pane refusal must win (the pane rung is checked first).
    expect(h.forward.closeLane(refFor(1), "viewer-left")).toEqual({ closed: true });
    expect((await openIn(PANES[0])).ok).toBe(true);
    expect(h.forward.laneCount()).toBe(16);
    expect(await openIn(PANES[0])).toEqual({ ok: false, error: PREVIEW_LANE_OVER_PANE_CAP });
    expect(h.forward.laneCount()).toBe(16);
    expect(h.events).toHaveLength(0); // refusals start no mechanism and report no death
  });
});

/* ------------------------------------------------------------------ */
/* (e) idle, EOF-once, and the close-that-lands-first                  */
/* ------------------------------------------------------------------ */

describe("(e) idle and target death", () => {
  it("the idle budget self-closes with reason idle, and traffic resets it", () => {
    const h = makeHarness("idle", { deps: { idleMs: 250 } });
    const open = () =>
      h.forward.openLane({
        ref: refFor(1),
        port: 4321,
        paneId: PANE,
        lifetimeMs: 60_000,
        hooks: { emit: (ev) => h.events.push(ev) },
      });
    open();
    h.sockets[0]?.fire("connect"); // activity: resets the idle timer
    expect(h.clock.cancelledAt(250)).toBe(1); // the pre-connect timer was replaced
    h.forward.ingestInboundFrame({ type: "preview_data", ref: refFor(1), dir: "in", blob: "QUJD" }); // and so is this one
    expect(h.clock.cancelledAt(250)).toBe(2);
    expect(h.clock.liveAt(250)).toBe(1); // exactly one idle timer still armed
    expect(h.clock.fire(250)).toBe(1);
    expect(closeEvents(h.events)).toEqual([{ ref: refFor(1), reason: "idle" }]);
    expect(h.forward.laneCount()).toBe(0);
  });

  it("target EOF emits target-gone exactly once, and a close landing first suppresses it", () => {
    const h = makeHarness("eof");
    h.forward.openLane({
      ref: refFor(1),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60_000,
      hooks: { emit: (ev) => h.events.push(ev) },
    });
    h.sockets[0]?.fire("connect");
    h.sockets[0]?.fire("end"); // a real socket fires `end` then `close`
    h.sockets[0]?.fire("close"); // one emission total, not two
    expect(closeEvents(h.events)).toEqual([{ ref: refFor(1), reason: "target-gone" }]);
    expect(h.forward.laneCount()).toBe(0);

    const g = makeHarness("close-first");
    g.forward.openLane({
      ref: refFor(2),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60_000,
      hooks: { emit: (ev) => g.events.push(ev) },
    });
    g.sockets[0]?.fire("connect");
    expect(g.forward.closeLane(refFor(2), "viewer-left")).toEqual({ closed: true });
    g.sockets[0]?.fire("end"); // the late EOF finds no lane
    g.sockets[0]?.fire("close");
    g.clock.fire(900_000); // the ARMED idle budget, at the ms FakeClock matches: no timer can resurrect it
    expect(g.events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* (f) the slow-link guard                                             */
/* ------------------------------------------------------------------ */

describe("(f) slow link", () => {
  it("the first undeliverable chunk closes the lane instead of silently dropping TCP bytes", () => {
    const h = makeHarness("slow", { deps: { laneBufferMaxBytes: 64 } });
    // The recording pump: every frame is ATTEMPTED (recorded) and the byte
    // leg is REFUSED, which is the deliver-or-throw shape a dead link gives
    // the lane. The close notice rides the same recorder so the final event
    // is observable.
    const attempts: PreviewLaneEvent[] = [];
    h.forward.openLane({
      ref: refFor(1),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60_000,
      hooks: {
        emit: (ev) => {
          attempts.push(ev);
          if (ev.type === "preview_data") throw new Error("relay send refused: no live socket");
        },
      },
    });
    h.sockets[0]?.fire("connect");
    h.sockets[0]?.fire("data", Buffer.alloc(40, 7)); // even a single short chunk cannot be skipped
    expect(h.forward.laneCount()).toBe(0);
    expect(closeEvents(attempts)).toHaveLength(1);
    h.sockets[0]?.fire("data", Buffer.alloc(40, 7)); // later data cannot revive a truncated stream
    expect(dataEvents(attempts)).toHaveLength(1); // the second chunk never reaches the dead lane
    expect(closeEvents(attempts)).toEqual([{ ref: refFor(1), reason: "slow-link" }]);
    expect(h.sockets[0]?.destroyed).toBe(true);
    expect(h.forward.laneCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* (g) the mirror switch gates the open, not the close                 */
/* ------------------------------------------------------------------ */

describe("(g) the gate", () => {
  it("an off switch refuses preview_open before any dial or registration", async () => {
    const h = makeHarness("gate-off", { previewOn: false });
    const res = await dispatchCommand(h.ctx, openCmd());
    expect(res).toEqual({ ok: false, error: PREVIEW_NODE_OFF });
    expect(h.attempts).toHaveLength(0);
    expect(h.forward.laneCount()).toBe(0);
    expect(h.events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* (h) closeAll on link drop                                           */
/* ------------------------------------------------------------------ */

describe("(h) closeAll", () => {
  it("closes every lane with exactly one event each and empties the registry", () => {
    const h = makeHarness("close-all");
    for (const [i, paneId] of [PANES[0], PANES[1]].entries()) {
      h.forward.openLane({
        ref: refFor(i + 1),
        port: 4321,
        paneId,
        lifetimeMs: 60_000,
        hooks: { emit: (ev) => h.events.push(ev) },
      });
    }
    expect(h.forward.laneCount()).toBe(2);
    h.forward.closeAll("node-dropped");
    expect(closeEvents(h.events)).toEqual([
      { ref: refFor(1), reason: "node-dropped" },
      { ref: refFor(2), reason: "node-dropped" },
    ]);
    expect(h.forward.laneCount()).toBe(0);
    expect(h.sockets.every((s) => s.destroyed)).toBe(true);
    // A dial that lands after the sweep must not resurrect the lane.
    h.sockets[0]?.fire("connect");
    h.sockets[0]?.fire("data", Buffer.from("late"));
    expect(h.forward.laneCount()).toBe(0);
    expect(closeEvents(h.events)).toHaveLength(2);
    expect(dataEvents(h.events)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* (i) the oversized-read guard                                        */
/* ------------------------------------------------------------------ */

describe("(i) the byte caps, both directions", () => {
  it("closes a stalled target before its TCP write queue exceeds the lane budget", () => {
    const h = makeHarness("stalled-writer", { deps: { laneBufferMaxBytes: 64 } });
    h.forward.openLane({
      ref: refFor(1),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60_000,
      hooks: { emit: (ev) => h.events.push(ev) },
    });
    const send = (size: number) =>
      h.forward.ingestInboundFrame({
        type: "preview_data",
        ref: refFor(1),
        dir: "in",
        blob: Buffer.alloc(size).toString("base64"),
      });
    send(64);
    expect(h.sockets[0]?.writableLength).toBe(64);
    send(1);
    expect(h.sockets[0]?.writableLength).toBe(64);
    expect(h.sockets[0]?.destroyed).toBe(true);
    expect(closeEvents(h.events)).toEqual([{ ref: refFor(1), reason: "slow-link" }]);
    expect(h.forward.laneCount()).toBe(0);
  });

  it("splits large TCP reads into bounded frames without losing bytes", () => {
    const h = makeHarness("large-read");
    h.forward.openLane({
      ref: refFor(1),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 60_000,
      hooks: { emit: (ev) => h.events.push(ev) },
    });
    h.sockets[0]?.fire("connect");
    const bytes = Buffer.alloc(PREVIEW_FRAME_MAX_BYTES * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    h.sockets[0]?.fire("data", bytes);
    const frames = dataEvents(h.events).map((event) => Buffer.from(event.blob, "base64"));
    expect(frames.map((frame) => frame.length)).toEqual([PREVIEW_FRAME_MAX_BYTES, PREVIEW_FRAME_MAX_BYTES, 17]);
    expect(Buffer.concat(frames).equals(bytes)).toBe(true);
    expect(closeEvents(h.events)).toEqual([]);
    expect(h.forward.laneCount()).toBe(1);
    h.forward.closeLane(refFor(1), "viewer-left");
  });
});

/* ------------------------------------------------------------------ */
/* (j) the absolute lifetime                                           */
/* ------------------------------------------------------------------ */

describe("(j) lifetime", () => {
  it("the lifetime timer fires preview_closed idle exactly once per lane", () => {
    const h = makeHarness("lifetime");
    h.forward.openLane({
      ref: refFor(1),
      port: 4321,
      paneId: PANE,
      lifetimeMs: 40, // the seam exists to be small; the wire clamps to >= 60 s
      hooks: { emit: (ev) => h.events.push(ev) },
    });
    h.sockets[0]?.fire("connect");
    expect(h.clock.fire(40)).toBe(1);
    expect(closeEvents(h.events)).toEqual([{ ref: refFor(1), reason: "idle" }]);
    h.clock.fire(40); // a second fire of a dead timer changes nothing
    expect(closeEvents(h.events)).toHaveLength(1);
    expect(h.forward.laneCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* (k) pane liveness gates before registration                         */
/* ------------------------------------------------------------------ */

describe("(k) pane liveness", () => {
  it("an absent pane refuses preview-pane-gone before any registration or dial", async () => {
    const h = makeHarness("pane-gone", { panePid: null });
    const res = await dispatchCommand(h.ctx, openCmd());
    expect(res).toEqual({ ok: false, error: PREVIEW_PANE_GONE });
    expect(h.attempts).toHaveLength(0); // the fake connect never ran
    expect(h.forward.laneCount()).toBe(0); // and no lane appeared in the registry
    expect(h.events).toHaveLength(0);
  });
});
