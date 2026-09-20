import { describe, expect, it } from "bun:test";
import { handleLiveClose, handleLiveOpen, type LiveWsDeps, type LiveWsSocket } from "@/ws/live-ws.js";

/** A socket stand-in that records what it was sent and whether it was closed. */
function fakeSocket(query: Record<string, string> = {}) {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws: LiveWsSocket = {
    data: { query },
    send(data: string) {
      sent.push(data);
      return 1;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
  };
  return { ws, sent, closed, frames: () => sent.map((s) => JSON.parse(s)) };
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
    expect(closed.length).toBe(1);
    handleLiveClose(ws);
  });

  it("refuses an invalid or already-consumed token", async () => {
    const { ws, sent, closed } = fakeSocket({ token: "stale" });
    handleLiveOpen(ws, deps());
    await settle();
    expect(sent).toEqual([]);
    expect(closed.length).toBe(1);
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
   */
  it("stops ticking once the socket closes", async () => {
    const { ws, sent } = fakeSocket({ token: "good" });
    handleLiveOpen(ws, deps());
    await settle();
    handleLiveClose(ws);
    const at = sent.length;
    await settle(40);
    expect(sent.length).toBe(at);
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

  it("stops ticking when a send throws (the socket went away under us)", async () => {
    let sends = 0;
    const ws: LiveWsSocket = {
      data: { query: { token: "good" } },
      send() {
        sends += 1;
        throw new Error("socket closed");
      },
      close() {},
    };
    handleLiveOpen(ws, deps());
    await settle(40);
    expect(sends).toBe(1);
    handleLiveClose(ws);
  });

  it("closing a socket that never opened is harmless", () => {
    const { ws } = fakeSocket({});
    expect(() => handleLiveClose(ws)).not.toThrow();
  });
});
