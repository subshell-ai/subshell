import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_FRAME_MAX_BYTES,
  PREVIEW_SESSIONS_PER_NODE,
  PREVIEW_WATCH_FPS_DEFAULT,
  PREVIEW_WATCH_FRAMES_BUFFERED,
  PREVIEW_WATCH_JPEG_QUALITY,
  type PreviewOpenCommand,
  parseNodePreviewCloseResult,
  parseNodePreviewOpenResult,
} from "@internal/subshell-protocol";
import type { Server, ServerWebSocket } from "bun";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import {
  execPreviewOpen,
  PREVIEW_LANE_OVER_NODE_CAP,
  PREVIEW_NOT_CDP,
  PREVIEW_PANE_GONE,
  PREVIEW_WATCH_OVER_NODE_CAP,
} from "../commands/preview-open-exec.js";
import { PREVIEW_NODE_OFF } from "../commands/preview-ports-exec.js";
import {
  BRIDGE_HANDSHAKE_BUDGET_MS,
  type BridgeDeps,
  type BridgeWs,
  bridgeCloseAll,
  bridgeCount,
  clampFps,
  type PreviewClosedEvent,
  type PreviewStreamEvent,
  startBridge,
  stopBridge,
} from "../preview/cdp-bridge.js";
import { setPreviewEnabled } from "../preview/flags.js";
import { type LaneSocket, PreviewForward, type PreviewLaneEvent, setActivePreviewForward } from "../preview/forward.js";

/**
 * The CDP screencast bridge (pane-preview spec 2026-10-21 §5, Task 6): the
 * watch bridge behind `preview_open`'s `screencast` branch, the always-ack /
 * dropping-backpressure emission contract, and the SHARED node budget Task 6
 * adds to both open branches.
 *
 * The fake CDP is a real in-proc `Bun.serve` on a real loopback port: it
 * answers `/json/list`, records every message the bridge sends, and pushes
 * `Page.screencastFrame` notifications on the upgraded socket. Transport is
 * therefore real (global `fetch`, global `WebSocket`, a genuine mid-stream
 * close); only the clocks are fake (the `now`/`timer` seam) so the fps
 * throttle, the handshake budget, and the lifetime fire by hand instead of
 * by wall time.
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
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-preview-bridge-")));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* the fake CDP: real Bun.serve, /json/list + a recording ws           */
/* ------------------------------------------------------------------ */

interface FakeCdpOpts {
  /** HTTP status for /json/list (default 200). */
  listStatus?: number;
  /** The targets array answered on /json/list. */
  targets?: () => unknown;
}

interface WsData {
  messages: Record<string, unknown>[];
}

class FakeCdp {
  readonly server: Server<WsData>;
  readonly sockets: ServerWebSocket<WsData>[] = [];
  listRequests = 0;

  constructor(opts: FakeCdpOpts = {}) {
    this.server = Bun.serve<WsData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => {
        const path = new URL(req.url).pathname;
        if (path === "/json/list") {
          this.listRequests += 1;
          if (opts.listStatus && opts.listStatus !== 200) {
            return new Response(JSON.stringify({ message: "Not found" }), { status: opts.listStatus });
          }
          const targets =
            opts.targets ?? (() => [{ type: "page", url: "about:blank", webSocketDebuggerUrl: this.wsUrl("T1") }]);
          return Response.json(targets());
        }
        if (path.startsWith("/devtools/") && srv.upgrade(req, { data: { messages: [] } })) {
          return undefined as unknown as Response;
        }
        return new Response("nope", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.sockets.push(ws);
        },
        message: (ws, msg) => {
          if (typeof msg === "string") ws.data.messages.push(JSON.parse(msg) as Record<string, unknown>);
        },
      },
    });
  }

  /** Bun's port is optional on the type; a started fake always has one. */
  port(): number {
    const p = this.server.port;
    if (typeof p !== "number") throw new Error("fake CDP has no bound port");
    return p;
  }

  wsUrl(id: string): string {
    return `ws://127.0.0.1:${this.port()}/devtools/page/${id}`;
  }

  /** Every message the bridge has sent across every upgraded socket, in arrival order per socket. */
  messages(): Record<string, unknown>[] {
    return this.sockets.flatMap((ws) => ws.data.messages);
  }

  acks(): { sessionId: unknown }[] {
    return this.messages()
      .filter((m) => m.method === "Page.screencastFrameAck")
      .map((m) => (m.params ?? {}) as { sessionId: unknown });
  }

  /** Push one `Page.screencastFrame` notification on the most recent socket. */
  pushFrame(opts: { data: string; w?: number; h?: number; sessionId?: number } = { data: "AA==" }): void {
    const ws = this.sockets[this.sockets.length - 1];
    if (!ws) throw new Error("fake CDP has no upgraded socket to push on");
    ws.send(
      JSON.stringify({
        method: "Page.screencastFrame",
        params: {
          data: opts.data,
          metadata: { deviceWidth: opts.w ?? 800, deviceHeight: opts.h ?? 600 },
          sessionId: opts.sessionId ?? 1,
        },
      }),
    );
  }

  closeLastSocket(): void {
    const ws = this.sockets[this.sockets.length - 1];
    if (!ws) throw new Error("fake CDP has no upgraded socket to close");
    ws.close();
  }

  stop(): void {
    this.server.stop(true);
  }
}

/* ------------------------------------------------------------------ */
/* clocks and harnesses                                                */
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
}

/** A fake clock + counter: the bridge's `now` seam, advanced by the test. */
function makeNow(start = 1000): { now: () => number; set: (t: number) => void; advance: (d: number) => void } {
  let t = start;
  return { now: () => t, set: (v) => (t = v), advance: (d) => (t += d) };
}

class FakeSocket {
  private handlers = new Map<string, ((arg?: unknown) => void)[]>();
  destroyed = false;

  on(event: string, listener: (arg?: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  fire(event: string, arg?: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(arg);
  }

  write(_chunk: Uint8Array | string): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function makeHarness(
  tag: string,
  opts: { previewOn?: boolean; panePid?: number | null } = {},
): { ctx: CommandContext; forward: PreviewForward; events: PreviewLaneEvent[]; sockets: FakeSocket[] } {
  const dataDir = join(base, tag, "data");
  mkdirSync(dataDir, { recursive: true });
  if (opts.previewOn ?? true) setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
  const events: PreviewLaneEvent[] = [];
  const sockets: FakeSocket[] = [];
  const forward = new PreviewForward({
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as LaneSocket;
    },
    timer: new FakeClock(),
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
  return { ctx, forward, events, sockets };
}

function openCmd(over: Partial<PreviewOpenCommand> = {}): PreviewOpenCommand {
  return {
    type: "preview_open",
    ref: refFor(1),
    kind: "screencast",
    paneId: PANE,
    port: 0,
    lifetimeMs: 60_000,
    ...over,
  };
}

/** Poll until `cond`, then return. */
async function waitUntil(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Start one bridge against a live FakeCdp with production transport and fake clocks. */
async function startTestBridge(
  cdp: FakeCdp,
  ref: string,
  hooks: {
    emitStream: (ev: PreviewStreamEvent) => undefined | Promise<unknown>;
    emitClosed: (ev: PreviewClosedEvent) => void;
    deps?: BridgeDeps;
  },
  over: { fps?: number; lifetimeMs?: number } = {},
): Promise<void> {
  const clock = new FakeClock();
  await startBridge({
    ref,
    cdpPort: cdp.port(),
    fps: over.fps ?? PREVIEW_WATCH_FPS_DEFAULT, // the helper stands for the branch's default
    lifetimeMs: over.lifetimeMs ?? 60_000,
    emitStream: hooks.emitStream,
    emitClosed: hooks.emitClosed,
    deps: hooks.deps ?? { timer: clock },
  });
}

/** The frame data: a tiny base64 JPEG stand-in (nonempty, strict base64). */
const SMALL_BLOB = Buffer.from("jpeg-bytes").toString("base64");
const BIG_BLOB = Buffer.alloc(PREVIEW_FRAME_MAX_BYTES + 1, 7).toString("base64");

/* ------------------------------------------------------------------ */
/* (a) the handshake: what goes out, what the open answers             */
/* ------------------------------------------------------------------ */

describe("(a) the CDP handshake", () => {
  it("after Page.enable it starts the screencast at quality 60 / everyNthFrame 1, and the open acks subscribers: 1", async () => {
    const cdp = new FakeCdp();
    const h = makeHarness("handshake");
    try {
      const res = await execPreviewOpen(h.ctx, openCmd({ port: cdp.port(), ref: refFor(1) }));
      expect(res).toEqual({ ok: true, data: { ref: refFor(1), subscribers: 1 } });
      // Task 1's validator accepts the screencast result arm.
      expect(parseNodePreviewOpenResult(res.ok === true ? res.data : null)).toEqual({
        ref: refFor(1),
        subscribers: 1,
      });
      expect(bridgeCount()).toBe(1);
      await waitUntil(() => cdp.messages().length >= 2, "Page.enable and Page.startScreencast to arrive");
      const [enable, start] = cdp.messages();
      expect(enable?.method).toBe("Page.enable");
      expect(start?.method).toBe("Page.startScreencast");
      expect(start?.params).toEqual({ format: "jpeg", quality: PREVIEW_WATCH_JPEG_QUALITY, everyNthFrame: 1 });
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* (b) always-ack, dropping throttle                                   */
/* ------------------------------------------------------------------ */

describe("(b) the ack is unconditional, the emission is throttled", () => {
  it("three frames in one tick: at most one emission, three acks with the sessionId echoed", async () => {
    const cdp = new FakeCdp();
    const streams: PreviewStreamEvent[] = [];
    const clock = new FakeClock();
    const t = makeNow();
    try {
      await startBridge({
        ref: refFor(1),
        cdpPort: cdp.port(),
        fps: 5,
        lifetimeMs: 60_000,
        emitStream: (ev) => {
          streams.push(ev);
        },
        emitClosed: () => {},
        deps: { timer: clock, now: t.now },
      });
      await waitUntil(() => cdp.messages().length >= 2, "the screencast to start");
      cdp.pushFrame({ data: SMALL_BLOB, sessionId: 101 });
      cdp.pushFrame({ data: SMALL_BLOB, sessionId: 102 });
      cdp.pushFrame({ data: SMALL_BLOB, sessionId: 103 });
      await waitUntil(() => cdp.acks().length === 3, "three screencastFrameAcks");
      // Every capture got its immediate ack, whatever the emitter did with it.
      expect(cdp.acks().map((a) => a.sessionId)).toEqual([101, 102, 103]);
      // One tick, one emission: the extras are DROPPED at the emit boundary.
      expect(streams).toHaveLength(1);
      expect(streams[0]).toEqual({
        type: "preview_stream",
        ref: refFor(1),
        seq: 1,
        w: 800,
        h: 600,
        ts: t.now(),
        blob: SMALL_BLOB,
      });
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("fps absent defaults to 5: one frame per 200 ms of the fake clock", async () => {
    const cdp = new FakeCdp();
    const clock = new FakeClock();
    const t = makeNow();
    const h = makeHarness("fps-default");
    try {
      // The branch, not the wire, owns the default (node-frames.ts rebuilds
      // the command without `fps` and leaves the defaulting to Task 6). The
      // executor wires the bridge to the context's sender, so the emissions
      // land in the harness recorder.
      await execPreviewOpen(h.ctx, openCmd({ port: cdp.port(), ref: refFor(1) }), undefined, {
        timer: clock,
        now: t.now,
      });
      await waitUntil(() => cdp.messages().length >= 2, "the screencast to start");
      const streams = (): PreviewStreamEvent[] =>
        h.events.filter((e): e is PreviewStreamEvent => e.type === "preview_stream");
      cdp.pushFrame({ data: SMALL_BLOB });
      await waitUntil(() => cdp.acks().length === 1, "the first ack");
      t.advance(100);
      cdp.pushFrame({ data: SMALL_BLOB });
      await waitUntil(() => cdp.acks().length === 2, "the second ack");
      t.advance(100); // 200 ms total: the default-5 interval (ceil(1000/5))
      cdp.pushFrame({ data: SMALL_BLOB });
      await waitUntil(() => cdp.acks().length === 3, "the third ack");
      await waitUntil(() => streams().length >= 2, "the resumed emission");
      expect(streams()).toHaveLength(2); // frames at 0 and 200 ms pass; 100 ms drops
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("clampFps bounds the rate to [1, 5] and keeps the default", () => {
    expect(clampFps(0)).toBe(1);
    expect(clampFps(15)).toBe(5);
    expect(clampFps(PREVIEW_WATCH_FPS_DEFAULT)).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* (c) not-cdp: everything the handshake distrusts                     */
/* ------------------------------------------------------------------ */

describe("(c) not-cdp", () => {
  it("counts and cancels a handshake while discovery is still pending", async () => {
    let release: () => void = () => {};
    const discovery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcome = startBridge({
      ref: refFor(901),
      cdpPort: 9222,
      fps: 5,
      lifetimeMs: 60000,
      emitStream: () => {},
      emitClosed: () => {},
      deps: {
        fetch: async () => {
          await discovery;
          return { ok: true, status: 200, json: async () => [] };
        },
      },
    }).then(
      () => "opened",
      () => "cancelled",
    );
    expect(bridgeCount()).toBe(1);
    expect(stopBridge(refFor(901), "revoked")).toBe(true);
    expect(await outcome).toBe("cancelled");
    expect(bridgeCount()).toBe(0);
    release();
  });

  it("refuses another loopback browser port returned by a discovered endpoint", async () => {
    const foreign = new FakeCdp();
    const source = new FakeCdp({
      targets: () => [{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${foreign.port()}/devtools/page/T1` }],
    });
    try {
      await expect(
        startBridge({
          ref: refFor(900),
          cdpPort: source.port(),
          fps: 5,
          lifetimeMs: 60000,
          emitStream: () => {},
          emitClosed: () => {},
        }),
      ).rejects.toThrow("not-cdp");
      expect(foreign.sockets).toHaveLength(0);
      expect(bridgeCount()).toBe(0);
    } finally {
      bridgeCloseAll("viewer-left");
      source.stop();
      foreign.stop();
    }
  });

  it("a webSocketDebuggerUrl on a non-loopback host is refused without a dial", async () => {
    const cdp = new FakeCdp({
      targets: () => [{ type: "page", webSocketDebuggerUrl: "ws://9.9.9.9:9222/devtools/page/T1" }],
    });
    try {
      await expect(
        startBridge({
          ref: refFor(1),
          cdpPort: cdp.port(),
          fps: 5,
          lifetimeMs: 60_000,
          emitStream: () => {},
          emitClosed: () => {},
        }),
      ).rejects.toThrow("not-cdp");
      expect(bridgeCount()).toBe(0);
      // The URL came from /proc's port, answered by a socket: distrusted, never dialed.
      expect(cdp.sockets).toHaveLength(0);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("walks to ::1 for the target list when IPv4 has no socket, and still dials the page", async () => {
    // Discovery now reports a devtools endpoint bound to `::1` (the same ladder
    // in cdp-http.ts), so a bridge that knew only 127.0.0.1 would call that very
    // browser `not-cdp`: listed, watchable in principle, and refused on the
    // open. The list is asked on both spellings; the target it names still dials
    // whatever loopback the answer carries.
    const cdp = new FakeCdp();
    const h = makeHarness("v6-list");
    const asked: string[] = [];
    try {
      await startTestBridge(cdp, refFor(906), {
        emitStream: () => {},
        emitClosed: () => {},
        deps: {
          timer: new FakeClock(),
          fetch: async (url: string) => {
            asked.push(url);
            if (!url.includes("[::1]")) throw new TypeError("connect ECONNREFUSED 127.0.0.1");
            return {
              ok: true,
              status: 200,
              json: async () => [{ type: "page", url: "about:blank", webSocketDebuggerUrl: cdp.wsUrl("T1") }],
            };
          },
        },
      });
      expect(asked).toEqual([`http://127.0.0.1:${cdp.port()}/json/list`, `http://[::1]:${cdp.port()}/json/list`]);
      expect(cdp.sockets.length).toBeGreaterThan(0);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
      void h;
    }
  });

  it("a /json/list that 404s makes the open answer the not-cdp refusal, with no bridge left behind", async () => {
    const cdp = new FakeCdp({ listStatus: 404 });
    const h = makeHarness("not-cdp-404");
    try {
      const res = await execPreviewOpen(h.ctx, openCmd({ port: cdp.port(), ref: refFor(1) }));
      expect(res).toEqual({ ok: false, error: PREVIEW_NOT_CDP });
      expect(bridgeCount()).toBe(0);
      expect(h.events).toHaveLength(0); // the plane never held a ref: no close event to volunteer
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("a websocket that never opens dies on the 3 s handshake budget with not-cdp", async () => {
    const cdp = new FakeCdp();
    const clock = new FakeClock();
    let hung: { closed: boolean } | undefined;
    class HangingWs {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((err: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((msg: { data: string | Buffer }) => void) | null = null;
      closed = false;
      constructor() {
        hung = this;
      }
      send(_data: string): void {}
      close(): void {
        this.closed = true;
      }
    }
    try {
      const starting = startBridge({
        ref: refFor(1),
        cdpPort: cdp.port(),
        fps: 5,
        lifetimeMs: 60_000,
        emitStream: () => {},
        emitClosed: () => {},
        deps: { timer: clock, WebSocketImpl: HangingWs as unknown as new (url: string) => BridgeWs },
      });
      await waitUntil(() => hung !== undefined, "the websocket dial to start");
      expect(clock.fire(BRIDGE_HANDSHAKE_BUDGET_MS)).toBe(1);
      await expect(starting).rejects.toThrow("not-cdp");
      expect(bridgeCount()).toBe(0);
      expect(hung?.closed).toBe(true); // the hung socket is released, no half-started state
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* (d) bridge deaths                                                   */
/* ------------------------------------------------------------------ */

describe("(d) target death and lifetime", () => {
  it("a CDP socket close mid-stream emits preview_closed target-gone exactly once", async () => {
    const cdp = new FakeCdp();
    const closed: PreviewClosedEvent[] = [];
    try {
      await startTestBridge(cdp, refFor(1), {
        emitStream: () => {},
        emitClosed: (ev) => closed.push(ev),
      });
      await waitUntil(() => cdp.messages().length >= 2, "the screencast to start");
      cdp.closeLastSocket();
      await waitUntil(() => closed.length >= 1, "the target-gone notice");
      await new Promise((r) => setTimeout(r, 20)); // the close/error pair collapses to one
      expect(closed).toEqual([{ type: "preview_closed", ref: refFor(1), reason: "target-gone" }]);
      expect(bridgeCount()).toBe(0);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("lifetime expiry emits preview_closed idle exactly once", async () => {
    const cdp = new FakeCdp();
    const closed: PreviewClosedEvent[] = [];
    const clock = new FakeClock();
    try {
      await startBridge({
        ref: refFor(1),
        cdpPort: cdp.port(),
        fps: 5,
        lifetimeMs: 40, // the seam exists to be small; the wire clamps to >= 60 s
        emitStream: () => {},
        emitClosed: (ev) => closed.push(ev),
        deps: { timer: clock },
      });
      expect(clock.fire(40)).toBe(1);
      expect(closed).toEqual([{ type: "preview_closed", ref: refFor(1), reason: "idle" }]);
      clock.fire(40); // a second fire of a dead timer changes nothing
      expect(closed).toHaveLength(1);
      expect(bridgeCount()).toBe(0);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("a target that sends NO frames stays alive past the old 60 s traffic window, with no close", async () => {
    const cdp = new FakeCdp();
    const closed: PreviewClosedEvent[] = [];
    const clock = new FakeClock();
    try {
      await startBridge({
        ref: refFor(1),
        cdpPort: cdp.port(),
        fps: 5,
        lifetimeMs: 3_600_000,
        emitStream: () => {},
        emitClosed: (ev) => closed.push(ev),
        deps: { timer: clock },
      });
      await waitUntil(() => cdp.messages().length >= 2, "the screencast to start");
      // The anti-test for traffic-idle: a static page repaints nothing and
      // keeps its watch. Zero frames, zero closes, and no timer armed at the
      // old 60 s traffic window (the handshake budget is discharged too).
      expect(clock.liveAt(60_000)).toBe(0);
      expect(clock.liveAt(BRIDGE_HANDSHAKE_BUDGET_MS)).toBe(0);
      expect(clock.liveAt(3_600_000)).toBe(1); // only the lifetime remains
      expect(closed).toHaveLength(0);
      expect(bridgeCount()).toBe(1);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* (e) the emit boundary: size cap and drainable buffer cap            */
/* ------------------------------------------------------------------ */

describe("(e) the emit boundary", () => {
  it("a blob over PREVIEW_FRAME_MAX_BYTES is dropped (acked, bridge alive) and the next frame still emits", async () => {
    const cdp = new FakeCdp();
    const streams: PreviewStreamEvent[] = [];
    const clock = new FakeClock();
    const t = makeNow();
    try {
      await startBridge({
        ref: refFor(1),
        cdpPort: cdp.port(),
        fps: 5,
        lifetimeMs: 60_000,
        emitStream: (ev) => {
          streams.push(ev);
        },
        emitClosed: () => {},
        deps: { timer: clock, now: t.now },
      });
      await waitUntil(() => cdp.messages().length >= 2, "the screencast to start");
      cdp.pushFrame({ data: BIG_BLOB, sessionId: 104 });
      cdp.pushFrame({ data: SMALL_BLOB, sessionId: 105 });
      await waitUntil(() => cdp.acks().length === 2, "both acks (the ack contract is unconditional)");
      // The plane's parser refuses an over-cap blob; an emitting bridge would
      // corrupt the stream silently, so it is dropped at the boundary instead.
      await waitUntil(() => streams.length >= 1, "the within-cap frame");
      expect(streams).toHaveLength(1);
      expect(streams[0]?.blob).toBe(SMALL_BLOB);
      expect(bridgeCount()).toBe(1); // a dropped frame does not close the bridge
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("the buffered cap is DRAINABLE: a stalled emitStream drops past-cap frames, and emission resumes after the stall", async () => {
    const cdp = new FakeCdp();
    const streams: PreviewStreamEvent[] = [];
    const clock = new FakeClock();
    const t = makeNow();
    let release: () => void = () => {};
    const stalled = new Promise<void>((r) => (release = r));
    let first = true;
    try {
      await startBridge({
        ref: refFor(1),
        cdpPort: cdp.port(),
        fps: 5,
        lifetimeMs: 60_000,
        emitStream: (ev) => {
          streams.push(ev);
          if (first) {
            first = false;
            return stalled; // the pump is "behind": the queue fills behind this
          }
          return undefined;
        },
        emitClosed: () => {},
        deps: { timer: clock, now: t.now },
      });
      await waitUntil(() => cdp.messages().length >= 2, "the screencast to start");
      // Six frames, one per throttle window (spaced so only the queue cap can
      // drop them). The first is held by the stall; the registry may hold at
      // most PREVIEW_WATCH_FRAMES_BUFFERED, so exactly one is dropped.
      for (let i = 0; i < 6; i += 1) {
        if (i > 0) t.advance(200);
        cdp.pushFrame({ data: SMALL_BLOB });
        await waitUntil(() => cdp.acks().length === i + 1, `ack ${i + 1}`);
      }
      expect(bridgeCount()).toBe(1); // drops never close the bridge
      expect(streams).toHaveLength(1); // the stalled emission is the only attempt so far
      release();
      await waitUntil(() => streams.length === PREVIEW_WATCH_FRAMES_BUFFERED, "the queue to drain");
      expect(streams).toHaveLength(PREVIEW_WATCH_FRAMES_BUFFERED);
      // The counter-without-decrement design would go permanently dark here;
      // this resume is the assertion that tells the two designs apart.
      t.advance(200);
      cdp.pushFrame({ data: SMALL_BLOB });
      await waitUntil(() => cdp.acks().length === 7, "the seventh ack");
      await waitUntil(() => streams.length === PREVIEW_WATCH_FRAMES_BUFFERED + 1, "emission to resume");
      expect(streams.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(bridgeCount()).toBe(1);
    } finally {
      release();
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* (f) the gate ladder on the screencast branch                        */
/* ------------------------------------------------------------------ */

describe("(f) the gate ladder, screencast twin", () => {
  it("an off switch refuses preview-node-off BEFORE the CDP handshake", async () => {
    const cdp = new FakeCdp();
    const h = makeHarness("gate-off", { previewOn: false });
    try {
      const res = await execPreviewOpen(h.ctx, openCmd({ port: cdp.port() }));
      expect(res).toEqual({ ok: false, error: PREVIEW_NODE_OFF });
      expect(cdp.listRequests).toBe(0); // not even /json/list was asked
      expect(bridgeCount()).toBe(0);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("an absent pane refuses preview-pane-gone with zero requests reaching the CDP server", async () => {
    const cdp = new FakeCdp();
    const h = makeHarness("pane-gone", { panePid: null });
    try {
      const res = await execPreviewOpen(h.ctx, openCmd({ port: cdp.port() }));
      expect(res).toEqual({ ok: false, error: PREVIEW_PANE_GONE });
      expect(cdp.listRequests).toBe(0);
      expect(bridgeCount()).toBe(0);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* (g) the close fall-through and the sweep                            */
/* ------------------------------------------------------------------ */

describe("(g) preview_close falls forward to the bridge", () => {
  it("a bridge ref stops exactly once (forward miss -> bridge hit); an unknown ref keeps the tombstone", async () => {
    const cdp = new FakeCdp();
    const h = makeHarness("close-fallthrough");
    try {
      await startTestBridge(cdp, refFor(1), { emitStream: () => {}, emitClosed: (ev) => h.events.push(ev) });
      await waitUntil(() => cdp.messages().length >= 2, "the screencast to start");
      const res = await dispatchCommand(h.ctx, { type: "preview_close", ref: refFor(1), reason: "viewer-left" });
      expect(res).toEqual({ ok: true, data: { ref: refFor(1), closed: true } });
      expect(parseNodePreviewCloseResult(res.ok === true ? res.data : null)).toEqual({
        ref: refFor(1),
        closed: true,
      });
      expect(bridgeCount()).toBe(0);
      expect(h.events).toHaveLength(0); // the plane ordered this death; it is not volunteered
      // The tombstone twins: a second close, and a ref neither registry owns.
      expect(await dispatchCommand(h.ctx, { type: "preview_close", ref: refFor(1), reason: "viewer-left" })).toEqual({
        ok: true,
        data: { ref: refFor(1), closed: false },
      });
      expect(await dispatchCommand(h.ctx, { type: "preview_close", ref: refFor(9), reason: "viewer-left" })).toEqual({
        ok: true,
        data: { ref: refFor(9), closed: false },
      });
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("stopBridge answers false for a ref the bridge registry does not own", () => {
    expect(stopBridge(refFor(42), "viewer-left")).toBe(false);
  });

  it("bridgeCloseAll stops every bridge with exactly one emission each", async () => {
    const cdp = new FakeCdp();
    const closed: PreviewClosedEvent[] = [];
    try {
      await startTestBridge(cdp, refFor(1), { emitStream: () => {}, emitClosed: (ev) => closed.push(ev) });
      await waitUntil(() => cdp.sockets.length === 1, "the first socket");
      await startTestBridge(cdp, refFor(2), { emitStream: () => {}, emitClosed: (ev) => closed.push(ev) });
      await waitUntil(() => cdp.sockets.length === 2, "the second socket");
      expect(bridgeCount()).toBe(2);
      bridgeCloseAll("node-dropped");
      expect(closed).toEqual([
        { type: "preview_closed", ref: refFor(1), reason: "node-dropped" },
        { type: "preview_closed", ref: refFor(2), reason: "node-dropped" },
      ]);
      expect(bridgeCount()).toBe(0);
    } finally {
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("the sweep cancels an in-flight handshake: the late open never registers, sends nothing, volunteers nothing", async () => {
    // MINOR-1 (Task 6 review): a bridge registers only once the handshake
    // lands, so for up to the budget window a screencast open is invisible to
    // bridgeCloseAll. The plane's link must not be able to die inside that
    // window and leave a bridge streaming to nobody until its lifetime expires.
    const clock = new FakeClock();
    let listRequests = 0;
    const sends: string[] = [];
    let late: HeldWs | undefined;
    class HeldWs {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((err: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((msg: { data: string | Buffer }) => void) | null = null;
      closed = false;
      constructor() {
        late = this;
      }
      send(data: string): void {
        sends.push(data);
      }
      close(): void {
        this.closed = true;
      }
      open(): void {
        this.onopen?.({});
      }
    }
    const events: PreviewLaneEvent[] = [];
    // Observe the eventual outcome from the start: the fix rejects during the
    // sweep, long before the test awaits, and an unattached rejection would
    // leak into the next test.
    const outcome = startBridge({
      ref: refFor(1),
      cdpPort: 9222,
      fps: 5,
      lifetimeMs: 60_000,
      emitStream: (ev) => {
        events.push(ev);
      },
      emitClosed: (ev) => {
        events.push(ev);
      },
      deps: {
        timer: clock,
        fetch: async () => {
          listRequests += 1;
          return {
            ok: true,
            status: 200,
            json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/T1" }],
          };
        },
        WebSocketImpl: HeldWs as unknown as new (url: string) => BridgeWs,
      },
    }).then(
      () => ({ status: "resolved" as const }),
      (err: unknown) => ({ status: "rejected" as const, why: String(err) }),
    );
    try {
      await waitUntil(() => listRequests === 1 && late !== undefined, "the list answer and the websocket dial");
      bridgeCloseAll("node-dropped"); // the link dies with the open not yet fired
      expect(late?.closed).toBe(true); // the sweep releases the in-flight socket at once
      late?.open(); // and the open lands anyway, after the sweep has run
      expect(await outcome).toEqual({ status: "rejected", why: "Error: node-dropped" });
      expect(bridgeCount()).toBe(0); // the late handshakeOpen must not register
      expect(sends).toHaveLength(0); // no Page.enable, no screencast, on a dead link
      expect(events).toHaveLength(0); // nothing volunteered: the plane never held this ref
      expect(clock.liveAt(60_000)).toBe(0); // no lifetime armed for a bridge that never was
    } finally {
      bridgeCloseAll("viewer-left");
    }
  });
});

/* ------------------------------------------------------------------ */
/* (h) the SHARED node budget: one counter over both registries        */
/* ------------------------------------------------------------------ */

describe("(h) the shared node budget", () => {
  it("15 lanes + 1 bridge fill the node; the NEXT bridge refuses watch-over-node-cap before the dial", async () => {
    expect(PREVIEW_SESSIONS_PER_NODE).toBe(16);
    const cdp = new FakeCdp();
    const h = makeHarness("shared-budget-bridge");
    setActivePreviewForward(h.forward); // the daemon boot handle; the executor reads THIS registry directly
    try {
      // 15 lanes spread 4-per-pane (the per-pane cap is its own rung; this
      // case is about the NODE sum, so the lanes must not trip it first).
      for (let i = 1; i <= 15; i += 1) {
        const paneId = PANES[Math.floor((i - 1) / 4) % PANES.length] ?? PANE;
        expect((await dispatchCommand(h.ctx, { ...openCmd(), kind: "forward", ref: refFor(i), paneId })).ok).toBe(true);
      }
      expect(h.forward.laneCount()).toBe(15);
      // The bridge that fills slot 16 starts (its CDP requests are the proof).
      const before = cdp.listRequests;
      const ok16 = await dispatchCommand(h.ctx, openCmd({ ref: refFor(16), port: cdp.port() }));
      expect(ok16).toEqual({ ok: true, data: { ref: refFor(16), subscribers: 1 } });
      expect(cdp.listRequests).toBeGreaterThan(before);
      expect(bridgeCount()).toBe(1);
      // The 17th of any mix refuses BEFORE the handshake: zero new requests.
      const mid = cdp.listRequests;
      expect(await dispatchCommand(h.ctx, openCmd({ ref: refFor(17), port: cdp.port() }))).toEqual({
        ok: false,
        error: PREVIEW_WATCH_OVER_NODE_CAP,
      });
      expect(cdp.listRequests).toBe(mid);
      expect(bridgeCount()).toBe(1);
    } finally {
      setActivePreviewForward(undefined);
      h.forward.closeAll("viewer-left");
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });

  it("15 bridges + 1 lane fill the node; the NEXT lane refuses lane-over-node-cap before its connect", async () => {
    const cdp = new FakeCdp();
    const h = makeHarness("shared-budget-lane");
    try {
      for (let i = 1; i <= 15; i += 1) {
        await startBridge({
          ref: refFor(i),
          cdpPort: cdp.port(),
          fps: 5,
          lifetimeMs: 60_000,
          emitStream: () => {},
          emitClosed: () => {},
        });
      }
      expect(bridgeCount()).toBe(15);
      // The lane that fills slot 16 opens; its fake connect runs (pending).
      expect((await dispatchCommand(h.ctx, { ...openCmd(), kind: "forward", ref: refFor(16) })).ok).toBe(true);
      expect(h.sockets).toHaveLength(1);
      // The next lane refuses BEFORE the dial: the connect count stays 1.
      expect(await dispatchCommand(h.ctx, { ...openCmd(), kind: "forward", ref: refFor(17) })).toEqual({
        ok: false,
        error: PREVIEW_LANE_OVER_NODE_CAP,
      });
      expect(h.sockets).toHaveLength(1);
    } finally {
      h.forward.closeAll("viewer-left");
      bridgeCloseAll("viewer-left");
      cdp.stop();
    }
  });
});
