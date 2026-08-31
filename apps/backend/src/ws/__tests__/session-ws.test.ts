import { describe, expect, it } from "bun:test";
import type { TmuxRunner } from "@internal/harnesses";
import { handleSessionMessage, stripSyncMarkers, type WsSocket } from "@/ws/session-ws.js";

describe("stripSyncMarkers", () => {
  // xterm 6 withholds painting while DEC 2026 is open; TUIs that leave the
  // update open until their next redraw (claude-code does) stall paint ~1s,
  // so the markers are removed before the frame reaches the client.
  const BSU = "\x1b[?2026h";
  const ESU = "\x1b[?2026l";

  it("removes begin and end markers, keeping the frame content", () => {
    expect(stripSyncMarkers(`${BSU}hello${ESU}`)).toBe("hello");
  });

  it("removes a dangling begin marker (the case that caused the 1s paint stall)", () => {
    expect(stripSyncMarkers(`\x1b[3Am${BSU}`)).toBe("\x1b[3Am");
  });

  it("leaves plain text that merely mentions 2026 untouched", () => {
    expect(stripSyncMarkers("error 2026h and 2026l codes")).toBe("error 2026h and 2026l codes");
  });

  it("is a no-op on strings without the fast-path substring", () => {
    const s = "\x1b[1;32m ready";
    expect(stripSyncMarkers(s)).toBe(s);
  });
});

/** Records every tmux call the message handler makes. `canInput` defaults true (an edit/owner attach). */
function fakeSocket(opts: { canInput?: boolean } = {}) {
  const inputs: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const tmux = {
    sendInput: (_socket: string, _session: string, input: string) => inputs.push(input),
    resizeWindow: (_socket: string, _session: string, cols: number, rows: number) => resizes.push({ cols, rows }),
  } as unknown as TmuxRunner;
  const ws = {
    data: {
      tmux,
      socket: "sock",
      sessionId: "s1",
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

describe("handleSessionMessage", () => {
  it("forwards a keystroke without submitting it", () => {
    const { ws, inputs } = fakeSocket();
    for (const ch of "hello") handleSessionMessage(ws, JSON.stringify({ type: "input", data: ch }));
    expect(inputs).toEqual(["h", "e", "l", "l", "o"]);
  });

  it("forwards a multi-line paste as a single unmodified chunk", () => {
    const { ws, inputs } = fakeSocket();
    const data = "line one\nline two\n\nline four";
    handleSessionMessage(ws, JSON.stringify({ type: "input", data }));
    expect(inputs).toEqual([data]);
  });

  it("forwards control bytes verbatim", () => {
    const { ws, inputs } = fakeSocket();
    for (const data of ["\x04", "\x1b[A", "\r"]) {
      handleSessionMessage(ws, JSON.stringify({ type: "input", data }));
    }
    expect(inputs).toEqual(["\x04", "\x1b[A", "\r"]);
  });

  it("delivers a pasted JSON object verbatim instead of eating it as a control frame", () => {
    const { ws, inputs, resizes } = fakeSocket();
    const pasted = '{"type":"resize","cols":1,"rows":1}';
    handleSessionMessage(ws, JSON.stringify({ type: "input", data: pasted }));
    expect(inputs).toEqual([pasted]);
    expect(resizes).toEqual([]);
  });

  it("accepts an already-parsed frame object from Elysia", () => {
    const { ws, resizes } = fakeSocket();
    handleSessionMessage(ws, { type: "resize", cols: 120, rows: 40 });
    expect(resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("routes a resize frame to tmux instead of stdin", () => {
    const { ws, inputs, resizes } = fakeSocket();
    handleSessionMessage(ws, JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    expect(resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(inputs).toEqual([]);
  });

  it("a read-only (view) attach: input frames are dropped, resize still applies", () => {
    const { ws, inputs, resizes } = fakeSocket({ canInput: false });
    handleSessionMessage(ws, JSON.stringify({ type: "input", data: "ls\r" }));
    expect(inputs).toEqual([]); // keystrokes never reach the pane
    handleSessionMessage(ws, JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(resizes).toEqual([{ cols: 80, rows: 24 }]); // watching/resizing is fine
  });

  it("ignores an empty input frame", () => {
    const { ws, inputs } = fakeSocket();
    handleSessionMessage(ws, JSON.stringify({ type: "input", data: "" }));
    expect(inputs).toEqual([]);
  });

  it("drops malformed and unknown frames without throwing", () => {
    const { ws, inputs, resizes } = fakeSocket();
    handleSessionMessage(ws, "{not json");
    handleSessionMessage(ws, JSON.stringify({ type: "explode" }));
    handleSessionMessage(ws, "plain text is no longer input");
    expect(inputs).toEqual([]);
    expect(resizes).toEqual([]);
  });
});
