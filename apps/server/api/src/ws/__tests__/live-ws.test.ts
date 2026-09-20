import { describe, expect, it } from "bun:test";
import { handleLiveClose, handleLiveOpen, type LiveWsDeps, type LiveWsSocket } from "@/ws/live-ws.js";

/**
 * A socket stand-in shaped like the real thing: TWO wrapper objects sharing
 * ONE `data`.
 *
 * Elysia's bun adapter builds a fresh `ElysiaWS` per callback — `new
 * ElysiaWS(ws, context)` in both `open` and `close`, measured on 1.4.29 —
 * while `data` and `raw` are the same instances across the two. A double that
 * hands the same object to both calls cannot see a handler that keys its
 * state by the socket, which is exactly the leak this suite exists to catch:
 * the first version of it did that, and passed while every closed socket left
 * its interval running forever.
 */
function fakeSocket(query: Record<string, string> = {}) {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  // The one thing Elysia keeps stable across the two wrappers.
  const data: LiveWsSocket["data"] = { query };
  let readyState = 1; // OPEN
  const wrapper = (): LiveWsSocket => ({
    data,
    get readyState() {
      return readyState;
    },
    send(frame: string) {
      sent.push(frame);
      return 1;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      readyState = 3; // CLOSED
    },
  });
  return {
    /** What `open` is handed. */
    ws: wrapper(),
    /** What `close` is handed — a DIFFERENT object, same `data`. */
    closeWs: wrapper(),
    sent,
    closed,
    peerVanished: () => {
      readyState = 3;
    },
    frames: () => sent.map((s) => JSON.parse(s)),
  };
}

function deps(over: Partial<LiveWsDeps> = {}): LiveWsDeps {
  return {
    consumeToken: (t) => (t === "good" ? "u1" : null),
    listSubshells: async () => [{ id: "s1" }] as never,
    intervalMs: 5,
    ...over,
  };
}

/** Lets the open handler's first async snapshot settle. */
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

describe("/ws/live", () => {
  it("refuses a connection with no token and sends nothing", async () => {
    const { ws, sent, closed } = fakeSocket({});
    handleLiveOpen(ws, deps());
    await settle();
    expect(sent).toEqual([]);
    expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
    handleLiveClose(ws);
  });

  it("refuses an invalid or already-consumed token", async () => {
    const { ws, sent, closed } = fakeSocket({ token: "stale" });
    handleLiveOpen(ws, deps());
    await settle();
    expect(sent).toEqual([]);
    expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
    handleLiveClose(ws);
  });

  it("sends a snapshot immediately on a valid token, then on the interval", async () => {
    const { ws, frames } = fakeSocket({ token: "good" });
    handleLiveOpen(ws, deps());
    await settle();
    const first = frames();
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0]).toEqual({ type: "snapshot", subshells: [{ id: "s1" }] });
    const at = frames().length;
    await settle(30);
    expect(frames().length).toBeGreaterThan(at);
    handleLiveClose(ws);
  });

  /**
   * The SSE route this replaces leaked exactly here: a consumer that dropped
   * the body left the interval re-listing subshells — a DB read plus a tmux
   * capture per running pane — for a client that was gone.
   *
   * Closed through the OTHER wrapper on purpose. Elysia hands `close` a
   * different `ElysiaWS` than `open`, so a handler keying its state by the
   * socket object finds nothing here and ticks forever; only state reached
   * through the shared `data` survives the swap.
   */
  it("stops ticking once the socket closes — through the wrapper Elysia actually hands `close`", async () => {
    const { ws, closeWs, sent } = fakeSocket({ token: "good" });
    expect(closeWs).not.toBe(ws);
    expect(closeWs.data).toBe(ws.data);
    handleLiveOpen(ws, deps());
    await settle();
    handleLiveClose(closeWs);
    const at = sent.length;
    await settle(40);
    expect(sent.length).toBe(at);
  });

  /**
   * The other half: a peer that vanishes without a `close` callback. `send()`
   * does NOT throw into a dead socket on bun 1.4.2 — it returns 0 — so
   * `readyState` is the only signal a running tick can read.
   */
  it("stops ticking when the peer has gone without a close callback", async () => {
    const { ws, sent, peerVanished } = fakeSocket({ token: "good" });
    handleLiveOpen(ws, deps());
    await settle();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    peerVanished();
    const at = sent.length;
    await settle(40);
    expect(sent.length).toBe(at);
  });

  it("closing twice is harmless", async () => {
    const { ws, closeWs } = fakeSocket({ token: "good" });
    handleLiveOpen(ws, deps());
    await settle();
    handleLiveClose(closeWs);
    expect(() => handleLiveClose(closeWs)).not.toThrow();
  });

  it("keeps the feed alive when a list read fails", async () => {
    let calls = 0;
    const { ws, closed, frames } = fakeSocket({ token: "good" });
    handleLiveOpen(
      ws,
      deps({
        listSubshells: async () => {
          calls += 1;
          if (calls === 1) throw new Error("db hiccup");
          return [{ id: "s2" }] as never;
        },
      }),
    );
    await settle(40);
    expect(closed).toEqual([]);
    const snapshots = frames().filter((f) => f.type === "snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0]).toEqual({ type: "snapshot", subshells: [{ id: "s2" }] });
    handleLiveClose(ws);
  });

  it("closing a socket that never opened is harmless", () => {
    const { ws } = fakeSocket({});
    expect(() => handleLiveClose(ws)).not.toThrow();
  });
});
