import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { getRequestlessContext } from "@/lib/context.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { parseClientBuild } from "@/ws/attach-params.js";
import { handleSubshellMessage } from "@/ws/subshell-ws.js";
import { registerViewer, resetGeometryQueueForTests, resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";

// stripSyncMarkers / SyncStreamStripper moved to ws/sync-stripper.ts —
// pinned there by __tests__/sync-stripper.test.ts.

/** Records every launcher call the message handler makes. `canInput` defaults true (an edit/owner attach). */
function fakeSocket(
  opts: { canInput?: boolean; subshellId?: string; sid?: string; failInput?: boolean; attendsPush?: boolean } = {},
) {
  const inputs: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const subshellId = opts.subshellId ?? "s1";
  // Async-shaped like NodeLauncher. Input still dispatches synchronously; a
  // resize now goes through the geometry queue, which awaits `resize` and then
  // `paneSize`, so resize assertions have to let a microtask run (see `tick`).
  const launcher = {
    sendInput: async (_socket: string, _session: string, input: string) => {
      if (opts.failInput) throw new Error("pane gone");
      inputs.push(input);
    },
    resize: async (_socket: string, _session: string, cols: number, rows: number) => {
      resizes.push({ cols, rows });
    },
    // Echoes the last applied size: a pane that takes every request, which is
    // the case where the client's grid and the pane agree.
    paneSize: async () => resizes.at(-1) ?? null,
  } as unknown as NodeLauncher;
  const ws = {
    data: {
      launcher,
      socket: "sock",
      subshellId,
      logFile: "/dev/null",
      canInput: opts.canInput ?? true,
      // Stamped by the open handler from `resolveAttach` in production; the
      // unseen-push tests set it by hand like everything else here.
      ...(opts.attendsPush ? { attendsPush: true } : {}),
      // The registry is keyed by viewerId, so a fake without one registers
      // as nothing and its resize frames reach no pane.
      viewerId: crypto.randomUUID(),
      deviceLabel: "Test device",
      since: new Date().toISOString(),
      // The attach session rides the upgrade query (`&sid=`), which the
      // adapter spread onto ws.data: the same channel the handler reads.
      ...(opts.sid ? { query: { sid: opts.sid } } : {}),
    },
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
    close: () => undefined,
  } as unknown as WsSocket;
  // A resize frame reports what THIS viewer can display, and the pane's size
  // is then decided across every REGISTERED viewer — so a socket that never
  // registered has no say and nothing reaches tmux. Every real attach
  // registers; the fake must too, or these cases test an unreachable state.
  registerViewer(ws, subshellId);
  return { ws, inputs, resizes, sent, subshellId };
}

/** Lets the geometry queue's apply + readback settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("handleSubshellMessage", () => {
  it("forwards a keystroke without submitting it", () => {
    const { ws, inputs } = fakeSocket();
    for (const ch of "hello") handleSubshellMessage(ws, JSON.stringify({ type: "input", data: ch }));
    expect(inputs).toEqual(["h", "e", "l", "l", "o"]);
  });

  it("forwards a multi-line paste as a single unmodified chunk", () => {
    const { ws, inputs } = fakeSocket();
    const data = "line one\nline two\n\nline four";
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data }));
    expect(inputs).toEqual([data]);
  });

  it("forwards control bytes verbatim", () => {
    const { ws, inputs } = fakeSocket();
    for (const data of ["\x04", "\x1b[A", "\r"]) {
      handleSubshellMessage(ws, JSON.stringify({ type: "input", data }));
    }
    expect(inputs).toEqual(["\x04", "\x1b[A", "\r"]);
  });

  it("delivers a pasted JSON object verbatim instead of eating it as a control frame", () => {
    const { ws, inputs, resizes } = fakeSocket();
    const pasted = '{"type":"resize","cols":1,"rows":1}';
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: pasted }));
    expect(inputs).toEqual([pasted]);
    expect(resizes).toEqual([]);
  });

  it("accepts an already-parsed frame object from Elysia", () => {
    const { ws, resizes } = fakeSocket();
    handleSubshellMessage(ws, { type: "resize", cols: 120, rows: 40 });
    expect(resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("routes a resize frame to tmux instead of stdin", async () => {
    const { ws, inputs, resizes, subshellId } = fakeSocket({ subshellId: "resize-basic" });
    resetGeometryQueueForTests([subshellId]);
    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await tick();
    expect(resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(inputs).toEqual([]);
  });

  it("a read-only (view) attach: input frames are dropped, resize still applies", async () => {
    const { ws, inputs, resizes, subshellId } = fakeSocket({ canInput: false, subshellId: "resize-view" });
    resetGeometryQueueForTests([subshellId]);
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "ls\r" }));
    expect(inputs).toEqual([]); // keystrokes never reach the pane
    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await tick();
    expect(resizes).toEqual([{ cols: 80, rows: 24 }]); // watching/resizing is fine
  });

  it("collapses a resize burst into one tmux round trip carrying the last size", async () => {
    // A sash drag or a phone rotation emits a resize per animation frame.
    // Each extra round trip is a chance for two to complete out of order and
    // strand the pane at a superseded size.
    const { ws, resizes, subshellId } = fakeSocket({ subshellId: "resize-burst" });
    resetGeometryQueueForTests([subshellId]);
    for (const [cols, rows] of [
      [100, 30],
      [101, 30],
      [102, 31],
      [110, 35],
    ]) {
      handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols, rows }));
    }
    await tick();
    await tick();
    expect(resizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 110, rows: 35 },
    ]);
  });

  it("announces the settled size to the viewer as a geometry frame", async () => {
    const { ws, sent, subshellId } = fakeSocket({ subshellId: "resize-geom" });
    resetGeometryQueueForTests([subshellId]);
    resetLiveViewersForTests();
    registerViewer(ws, subshellId); // registers this socket as the viewer
    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 92, rows: 28 }));
    await tick();
    // Filtered, not exact: the socket also carries `viewers` presence frames
    // now, and this case is about the geometry announcement.
    expect(sent.filter((f) => f.type === "geometry")).toEqual([{ type: "geometry", cols: 92, rows: 28 }]);
    resetLiveViewersForTests();
  });

  it("announces the pane's REAL size when tmux does not take the request", async () => {
    // The measured defect: the browser asked 51x13 and the pane sat at 51x16.
    // The client must be told 16, not have its own request echoed back.
    const { ws, sent, subshellId } = fakeSocket({ subshellId: "resize-clamped" });
    (ws.data as unknown as { launcher: { paneSize: () => Promise<unknown> } }).launcher.paneSize = async () => ({
      cols: 51,
      rows: 16,
    });
    resetGeometryQueueForTests([subshellId]);
    resetLiveViewersForTests();
    registerViewer(ws, subshellId);
    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 51, rows: 13 }));
    await tick();
    expect(sent.filter((f) => f.type === "geometry")).toEqual([{ type: "geometry", cols: 51, rows: 16 }]);
    resetLiveViewersForTests();
  });

  it("ignores an empty input frame", () => {
    const { ws, inputs } = fakeSocket();
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "" }));
    expect(inputs).toEqual([]);
  });

  it("drops malformed and unknown frames without throwing", () => {
    const { ws, inputs, resizes } = fakeSocket();
    handleSubshellMessage(ws, "{not json");
    handleSubshellMessage(ws, JSON.stringify({ type: "explode" }));
    handleSubshellMessage(ws, "plain text is no longer input");
    expect(inputs).toEqual([]);
    expect(resizes).toEqual([]);
  });

  it("acks an input id after the pane write lands, to the sending socket only", async () => {
    const { ws, inputs, sent } = fakeSocket({ subshellId: "ack-write", sid: "sess-a" });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "x", id: 1 }));
    // The ack is emitted in the write's success path, one microtask later.
    await tick();
    expect(inputs).toEqual(["x"]);
    expect(sent.filter((f) => f.type === "ack")).toEqual([{ type: "ack", id: 1 }]);
  });

  it("dedupes a re-sent id without a second pane write, and still acks it", async () => {
    const { ws, inputs, sent } = fakeSocket({ subshellId: "ack-dedupe", sid: "sess-a" });
    for (let i = 0; i < 3; i++) {
      handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "x", id: 1 }));
      await tick();
    }
    // The retry after the first landed is absorbed by the completed-write
    // window: one write, three acks (the client must be able to retire the id).
    expect(inputs).toEqual(["x"]);
    expect(sent.filter((f) => f.type === "ack").length).toBe(3);
  });

  it("keys the window by session, so a second viewer's ids never collide", async () => {
    const a = fakeSocket({ subshellId: "ack-sessions", sid: "sess-a" });
    const b = fakeSocket({ subshellId: "ack-sessions", sid: "sess-b" });
    handleSubshellMessage(a.ws, JSON.stringify({ type: "input", data: "a", id: 1 }));
    await tick();
    handleSubshellMessage(b.ws, JSON.stringify({ type: "input", data: "b", id: 1 }));
    await tick();
    // Same id, different sessions: both writes land.
    expect(a.inputs).toEqual(["a"]);
    expect(b.inputs).toEqual(["b"]);
  });

  it("a failed write enters no window and acks nothing, so the retry can write it", async () => {
    const { ws, inputs, sent } = fakeSocket({ subshellId: "ack-fail", sid: "sess-a", failInput: true });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "x", id: 1 }));
    await tick();
    expect(inputs).toEqual([]);
    expect(sent.filter((f) => f.type === "ack")).toEqual([]);
    // Recovery: the pane works again and the client re-sends the same id,
    // which must now write, because the failed write entered no window.
    (ws.data as unknown as { launcher: { sendInput: (s: string, id: string, d: string) => Promise<void> } }).launcher =
      {
        sendInput: async (_socket: string, _session: string, input: string) => {
          inputs.push(input);
        },
        resize: async () => undefined,
        paneSize: async () => null,
      } as unknown as NodeLauncher;
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "x", id: 1 }));
    await tick();
    expect(inputs).toEqual(["x"]);
    expect(sent.filter((f) => f.type === "ack")).toEqual([{ type: "ack", id: 1 }]);
  });

  it("an id without a session dedupes per socket (viewerId fallback)", async () => {
    const { ws, inputs, sent } = fakeSocket({ subshellId: "ack-nosid" });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "x", id: 1 }));
    await tick();
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "x", id: 1 }));
    await tick();
    expect(inputs).toEqual(["x"]);
    expect(sent.filter((f) => f.type === "ack").length).toBe(2);
  });

  it("no-id frames behave exactly as before: written, never acked", async () => {
    const { ws, inputs, sent } = fakeSocket({ subshellId: "ack-legacy" });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "x" }));
    await tick();
    expect(inputs).toEqual(["x"]);
    expect(sent).toEqual([]);
  });

  it("resetLiveViewersForTests clears the input windows", async () => {
    const first = fakeSocket({ subshellId: "ack-reset", sid: "sess-a" });
    handleSubshellMessage(first.ws, JSON.stringify({ type: "input", data: "x", id: 1 }));
    await tick();
    expect(first.inputs).toEqual(["x"]);
    resetLiveViewersForTests();
    // A fresh case on the same subshell id and session: the id is writable
    // again; a surviving window would have swallowed it as a duplicate.
    const second = fakeSocket({ subshellId: "ack-reset", sid: "sess-a" });
    handleSubshellMessage(second.ws, JSON.stringify({ type: "input", data: "y", id: 1 }));
    await tick();
    expect(second.inputs).toEqual(["y"]);
  });
});

/**
 * `sid=` on the attach URL is the input-retry session key (spec 2026-09-21
 * Wave A). It is a key the server owns, never trusted display data, so it is
 * reduced to a safe alphabet: the same posture as `build=`.
 */
describe("input session sanitization", () => {
  it("keeps a normal session id and reduces a hostile one", async () => {
    const { sanitizeInputSession } = await import("@/ws/input-window.js");
    expect(sanitizeInputSession("abc-123_X")).toBe("abc-123_X");
    expect(sanitizeInputSession(`a"b\nc`)).toBe("abc");
    expect(sanitizeInputSession("x".repeat(80))).toBe("x".repeat(64));
    expect(sanitizeInputSession("")).toBeUndefined();
    expect(sanitizeInputSession(undefined)).toBeUndefined();
  });
});

/**
 * `build=` on the attach URL (2026-09-04): the journal must state WHICH client
 * bundle is talking, because a cached PWA runs pre-fix JavaScript across
 * server deploys and static requests are not logged.
 */
describe("parseClientBuild", () => {
  const at = (q: string) => new URL(`ws://localhost/ws?subshell=s&token=t${q}`);

  it("reads the client's reported build id", () => {
    expect(parseClientBuild(at("&build=DGQT8EKK"))).toBe("DGQT8EKK");
  });

  it("MISSING when absent or empty — a client older than the field", () => {
    expect(parseClientBuild(at(""))).toBe("MISSING");
    expect(parseClientBuild(at("&build="))).toBe("MISSING");
  });

  it("is display-only: hostile input is reduced, never trusted or echoed raw", () => {
    // It lands in a log line, so strip anything that could forge one.
    expect(parseClientBuild(at(`&build=${encodeURIComponent('a b"\n c')}`))).toBe("abc");
    expect(parseClientBuild(at(`&build=${"x".repeat(80)}`))).toBe("x".repeat(24));
    expect(parseClientBuild(at(`&build=${encodeURIComponent("!!!")}`))).toBe("MISSING");
  });

  it("keeps the dev sentinel intact", () => {
    expect(parseClientBuild(at("&build=dev"))).toBe("dev");
  });
});

/**
 * Typing into a pane answers its unseen push (operator report 2026-09-25):
 * the two prior answering events were both BOUNDARIES (the detail read, the
 * attach), so a push that arrived while the owner was already attached,
 * already looking, kept its bell until the next reload — exactly the "the
 * needs-attention flag won't clear while I'm interacting with it" complaint.
 * The shared input handler is now the third answering event.
 */
describe("handleSubshellMessage answers the unseen push on the owner's keystroke", () => {
  const seen: string[] = [];
  beforeAll(async () => {
    await setupAuthTables();
  });
  afterAll(async () => {
    for (const id of seen) await db.deleteFrom("subshells").where("id", "=", id).execute();
  });

  async function unseenRow(userId: string): Promise<string> {
    const { repos } = getRequestlessContext();
    const row = await repos.subshells.create({
      id: crypto.randomUUID(),
      userId,
      presetId: null,
      harnessId: "shell",
      name: "ws-typing-unseen",
      workingDir: "/tmp",
      tmuxSocket: "subshell-ws-typing",
      status: "running",
      alive: 1,
      lastPushUrgency: 2,
    });
    seen.push(row.id);
    return row.id;
  }
  const urgencyOf = async (id: string) => (await getRequestlessContext().repos.subshells.findById(id))?.lastPushUrgency;

  it("an attending owner socket clears it on the first typed frame", async () => {
    const id = await unseenRow(`owner-${crypto.randomUUID()}@x.local`);
    const { ws, inputs } = fakeSocket({ subshellId: id, attendsPush: true });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "l" }));
    await tick(); // the answer is fire-and-forget; let the UPDATE + announce run
    expect(inputs).toEqual(["l"]); // the keystroke still reaches the pane untouched
    expect(await urgencyOf(id)).toBeNull();
  });

  it("a SECOND unseen interval on the same live socket is answered too (no latch)", async () => {
    const id = await unseenRow(`owner2-${crypto.randomUUID()}@x.local`);
    const { ws } = fakeSocket({ subshellId: id, attendsPush: true });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "a" }));
    await tick();
    expect(await urgencyOf(id)).toBeNull();
    // A new push lands (another turn the owner has not answered); the next
    // keystroke answers it — the socket does not stop attending after one.
    await getRequestlessContext().repos.subshells.update(id, { lastPushUrgency: 3 });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "b" }));
    await tick();
    expect(await urgencyOf(id)).toBeNull();
  });

  it("a NON-attending socket (a scoped token, a grantee) types but answers nothing", async () => {
    const id = await unseenRow(`someone-${crypto.randomUUID()}@x.local`);
    const { ws } = fakeSocket({ subshellId: id }); // attendsPush absent = not the human
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "l" }));
    await tick();
    expect(await urgencyOf(id)).toBe(2); // a machine credential attended nothing
  });

  it("a read-only (view) grantee's input is dropped and answers nothing", async () => {
    const id = await unseenRow(`view-${crypto.randomUUID()}@x.local`);
    const { ws, inputs } = fakeSocket({ subshellId: id, canInput: false, attendsPush: true });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "l" }));
    await tick();
    expect(inputs).toEqual([]);
    expect(await urgencyOf(id)).toBe(2);
  });
});
