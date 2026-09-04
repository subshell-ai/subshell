import { describe, expect, it } from "bun:test";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import {
  handleSubshellMessage,
  parseClientBuild,
  resizePaneForClient,
  type WsData,
  type WsSocket,
} from "@/ws/subshell-ws.js";

// stripSyncMarkers / SyncStreamStripper moved to ws/sync-stripper.ts —
// pinned there by __tests__/sync-stripper.test.ts.

/** Records every launcher call the message handler makes. `canInput` defaults true (an edit/owner attach). */
function fakeSocket(opts: { canInput?: boolean } = {}) {
  const inputs: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  // Async-shaped like NodeLauncher, but the bodies run synchronously on call
  // (async functions execute to the first await eagerly), so the handler's
  // fire-and-forget `void` dispatch is observable without awaiting.
  const launcher = {
    sendInput: async (_socket: string, _session: string, input: string) => {
      inputs.push(input);
    },
    resize: async (_socket: string, _session: string, cols: number, rows: number) => {
      resizes.push({ cols, rows });
    },
  } as unknown as NodeLauncher;
  const ws = {
    data: {
      launcher,
      socket: "sock",
      subshellId: "s1",
      logFile: "/dev/null",
      lastSize: 0,
      lastOutputWriteAt: 0,
      canInput: opts.canInput ?? true,
    },
    send: () => undefined,
    close: () => undefined,
  } as unknown as WsSocket;
  return { ws, inputs, resizes };
}

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

  it("routes a resize frame to tmux instead of stdin", () => {
    const { ws, inputs, resizes } = fakeSocket();
    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    expect(resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(inputs).toEqual([]);
  });

  it("a read-only (view) attach: input frames are dropped, resize still applies", () => {
    const { ws, inputs, resizes } = fakeSocket({ canInput: false });
    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "ls\r" }));
    expect(inputs).toEqual([]); // keystrokes never reach the pane
    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(resizes).toEqual([{ cols: 80, rows: 24 }]); // watching/resizing is fine
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

/**
 * Geometry reconciliation (2026-09-04 root cause). Resizes used to be
 * `void`-fired: unordered, unmeasured, unacknowledged. A request that was lost
 * or overtaken left the pane at a different size than the browser's grid, and
 * because Claude Code positions every frame with RELATIVE moves and rewrites
 * only changed spans, every later frame landed on the wrong rows — the screen
 * froze mid-selection until a reattach. Measured live: a 13-row client against
 * a 16-row pane, with `capture-pane` pristine the whole time.
 */
describe("resizePaneForClient", () => {
  function harness(opts: { paneSize?: (c: number, r: number) => { cols: number; rows: number } | null } = {}) {
    const applied: Array<{ cols: number; rows: number }> = [];
    let last = { cols: 0, rows: 0 };
    const sent: string[] = [];
    const launcher = {
      async resize(_s: string, _i: string, cols: number, rows: number) {
        await Bun.sleep(5); // a real tmux round trip: long enough to overlap
        applied.push({ cols, rows });
        last = { cols, rows };
      },
      async paneSize() {
        return opts.paneSize ? opts.paneSize(last.cols, last.rows) : last;
      },
    } as unknown as NodeLauncher;
    const data = { launcher, socket: "sock", subshellId: "sid" } as WsData;
    const ws = { data, send: (s: string) => sent.push(s), close: () => {} } as unknown as WsSocket;
    return { ws, data, applied, sent };
  }

  it("acknowledges each applied resize with the pane's REAL size", async () => {
    const h = harness();
    await resizePaneForClient(h.ws, h.data, 80, 24);
    expect(h.applied).toEqual([{ cols: 80, rows: 24 }]);
    expect(h.sent).toEqual([JSON.stringify({ type: "geometry", cols: 80, rows: 24 })]);
  });

  it("coalesces a burst and the LAST request wins (the bug: it was 16 when 13 was asked)", async () => {
    const h = harness();
    // Three layout ticks in one turn, exactly the phone's pattern.
    const a = resizePaneForClient(h.ws, h.data, 51, 13);
    const b = resizePaneForClient(h.ws, h.data, 51, 16);
    const c = resizePaneForClient(h.ws, h.data, 51, 13);
    await Promise.all([a, b, c]);
    // One round trip for the first, one for the coalesced latest — never a
    // third, and never ending on the superseded 16.
    expect(h.applied.length).toBeLessThanOrEqual(2);
    expect(h.applied.at(-1)).toEqual({ cols: 51, rows: 13 });
    const lastAck = JSON.parse(h.sent.at(-1) ?? "{}");
    expect({ cols: lastAck.cols, rows: lastAck.rows }).toEqual({ cols: 51, rows: 13 });
  });

  it("reports what the pane ACTUALLY took, not what was requested", async () => {
    // A pane that refuses to shrink past 16 rows: the client must hear 16 so
    // it can re-ask or conform, instead of assuming its 13 landed.
    const h = harness({ paneSize: (cols, rows) => ({ cols, rows: Math.max(rows, 16) }) });
    await resizePaneForClient(h.ws, h.data, 51, 13);
    expect(JSON.parse(h.sent[0] ?? "{}")).toEqual({ type: "geometry", cols: 51, rows: 16 });
  });

  it("falls back to the requested size when the machine cannot measure (remote agent)", async () => {
    const h = harness({ paneSize: () => null });
    await resizePaneForClient(h.ws, h.data, 90, 30);
    expect(JSON.parse(h.sent[0] ?? "{}")).toEqual({ type: "geometry", cols: 90, rows: 30 });
  });

  it("sends NO acknowledgement when the resize fails — silence is the client's retry signal", async () => {
    const data = {
      launcher: {
        async resize() {
          throw new Error("pane gone");
        },
        async paneSize() {
          return null;
        },
      },
      socket: "s",
      subshellId: "i",
    } as unknown as WsData;
    const sent: string[] = [];
    const ws = { data, send: (s: string) => sent.push(s), close: () => {} } as unknown as WsSocket;
    await resizePaneForClient(ws, data, 80, 24);
    expect(sent).toEqual([]);
    expect(data.resizeRunning).toBe(false); // and the queue is not wedged
  });
});
