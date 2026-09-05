import { describe, expect, it } from "bun:test";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { parseClientBuild } from "@/ws/attach-params.js";
import { handleSubshellMessage } from "@/ws/subshell-ws.js";
import { registerViewer, resetGeometryQueueForTests, resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";

// stripSyncMarkers / SyncStreamStripper moved to ws/sync-stripper.ts —
// pinned there by __tests__/sync-stripper.test.ts.

/** Records every launcher call the message handler makes. `canInput` defaults true (an edit/owner attach). */
function fakeSocket(opts: { canInput?: boolean; subshellId?: string } = {}) {
  const inputs: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const subshellId = opts.subshellId ?? "s1";
  // Async-shaped like NodeLauncher. Input still dispatches synchronously; a
  // resize now goes through the geometry queue, which awaits `resize` and then
  // `paneSize`, so resize assertions have to let a microtask run (see `tick`).
  const launcher = {
    sendInput: async (_socket: string, _session: string, input: string) => {
      inputs.push(input);
    },
    resize: async (_socket: string, _session: string, cols: number, rows: number) => {
      resizes.push({ cols, rows });
    },
    // Echoes the last applied size: a pane that takes every request, which is
    // the case where the client's grid and the pane agree.
    paneSize: async () => resizes.at(-1) ?? null,
    // Measurable, like the tmux launcher this stands in for: a null read
    // therefore means the pane DIED, and nothing is announced.
    reportsPaneSize: () => true,
  } as unknown as NodeLauncher;
  const ws = {
    data: {
      launcher,
      socket: "sock",
      subshellId,
      logFile: "/dev/null",
      canInput: opts.canInput ?? true,
      // The registry is keyed by viewerId, so a fake without one registers
      // as nothing and its resize frames reach no pane.
      viewerId: crypto.randomUUID(),
      deviceLabel: "Test device",
      since: new Date().toISOString(),
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
