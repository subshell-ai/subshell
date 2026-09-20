import { describe, expect, it } from "bun:test";
import { ADMINS_TOPIC, EVERYONE_TOPIC, userTopic } from "@/ws/live-topics.js";
import {
  handleLiveClose,
  handleLiveMessage,
  handleLiveOpen,
  type LiveWsDeps,
  type LiveWsSocket,
  MAX_PREVIEW_REQUEST,
} from "@/ws/live-ws.js";

/**
 * A socket stand-in shaped like the real thing: TWO wrapper objects sharing
 * ONE `data`.
 *
 * Elysia's bun adapter builds a fresh `ElysiaWS` per callback — `new
 * ElysiaWS(ws, context)` in both `open` and `close`, measured on 1.4.29 —
 * while `data` and `raw` are the same instances across the two. A double that
 * hands the same object to both calls cannot see a handler keying state by
 * the socket, which is how the first version of this endpoint leaked an
 * interval per closed socket while its test stayed green.
 */
function fakeSocket(query: Record<string, string> = {}) {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const subscribed: string[] = [];
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
    subscribe(topic: string) {
      subscribed.push(topic);
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
    subscribed,
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
    isAdmin: async () => false,
    previewsFor: async () => new Map(),
    ...over,
  };
}

describe("/ws/live", () => {
  it("refuses a connection with no token and sends nothing", async () => {
    const { ws, sent, closed, subscribed } = fakeSocket({});
    await handleLiveOpen(ws, deps());
    expect(sent).toEqual([]);
    expect(subscribed).toEqual([]);
    expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
  });

  it("refuses an invalid or already-consumed token", async () => {
    const { ws, sent, closed } = fakeSocket({ token: "stale" });
    await handleLiveOpen(ws, deps());
    expect(sent).toEqual([]);
    expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
  });

  it("sends exactly ONE snapshot — the 1.5 s cadence is gone", async () => {
    const { ws, frames } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, deps());
    expect(frames()).toEqual([{ type: "snapshot", subshells: [{ id: "s1" }] }]);
    // Nothing is scheduled, so waiting produces no second frame.
    await new Promise((r) => setTimeout(r, 40));
    expect(frames().length).toBe(1);
    handleLiveClose(ws);
  });

  it("subscribes the viewer's topics BEFORE reading the list, so no event in that window is lost", async () => {
    let subscribedAtRead: string[] = [];
    const probe = fakeSocket({ token: "good" });
    await handleLiveOpen(
      probe.ws,
      deps({
        listSubshells: async () => {
          subscribedAtRead = [...probe.subscribed];
          return [] as never;
        },
      }),
    );
    expect(subscribedAtRead).toEqual([userTopic("u1"), EVERYONE_TOPIC]);
  });

  it("subscribes an admin to the admins topic ALONE — one frame, not two", async () => {
    // That topic already carries every row, so adding this viewer's own would
    // deliver a subshell they OWN twice. Measured against a real server: an
    // admin owner received each frame two times until the sets were disjoint.
    const { ws, subscribed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, deps({ isAdmin: async () => true }));
    expect(subscribed).toEqual([ADMINS_TOPIC]);
  });

  it("keeps the socket open when the snapshot read fails", async () => {
    const { ws, sent, closed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, deps({ listSubshells: () => Promise.reject(new Error("db hiccup")) }));
    expect(sent).toEqual([]);
    expect(closed).toEqual([]);
  });

  /**
   * The close can land while the list read is still in flight. Sending into a
   * socket that has gone is not an error on bun (`send` returns 0 rather than
   * throwing), so nothing would complain — the guard is what keeps the frame
   * from being written at all.
   */
  it("does not send a snapshot that finished after the socket closed", async () => {
    const { ws, closeWs, sent } = fakeSocket({ token: "good" });
    let release: () => void = () => {};
    const pending = new Promise<never>((r) => {
      release = () => r([] as never);
    });
    const open = handleLiveOpen(ws, deps({ listSubshells: () => pending }));
    handleLiveClose(closeWs);
    release();
    await open;
    expect(sent).toEqual([]);
  });

  it("does not send a snapshot when the peer vanished mid-read", async () => {
    const probe = fakeSocket({ token: "good" });
    await handleLiveOpen(
      probe.ws,
      deps({
        listSubshells: async () => {
          probe.peerVanished();
          return [] as never;
        },
      }),
    );
    expect(probe.sent).toEqual([]);
  });

  it("closing is safe before open, and twice", async () => {
    const { ws, closeWs } = fakeSocket({ token: "good" });
    expect(() => handleLiveClose(closeWs)).not.toThrow();
    await handleLiveOpen(ws, deps());
    handleLiveClose(closeWs);
    expect(() => handleLiveClose(closeWs)).not.toThrow();
  });
});

describe("/ws/live previews are pulled, never pushed", () => {
  it("answers a previews request with one frame per screen it could capture", async () => {
    const { ws, frames } = fakeSocket({ token: "good" });
    const d = deps({
      previewsFor: async (_u, ids) => new Map(ids.filter((i) => i !== "hidden").map((i) => [i, [`screen ${i}`]])),
    });
    await handleLiveOpen(ws, d);
    await handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: ["a", "hidden", "b"] }), d);
    expect(frames().filter((f) => f.type === "preview")).toEqual([
      { type: "preview", id: "a", lines: ["screen a"] },
      { type: "preview", id: "b", lines: ["screen b"] },
    ]);
  });

  it("captures nothing at connect — the snapshot is preview-free", async () => {
    let askedForPreviews = false;
    const { ws } = fakeSocket({ token: "good" });
    await handleLiveOpen(
      ws,
      deps({
        previewsFor: async () => {
          askedForPreviews = true;
          return new Map();
        },
      }),
    );
    expect(askedForPreviews).toBe(false);
  });

  it("ignores a frame that is not a previews request, and malformed JSON", async () => {
    const { ws, frames } = fakeSocket({ token: "good" });
    const d = deps({ previewsFor: async () => new Map([["a", ["x"]]]) });
    await handleLiveOpen(ws, d);
    const before = frames().length;
    await handleLiveMessage(ws, "not json at all", d);
    await handleLiveMessage(ws, JSON.stringify({ type: "something-else", ids: ["a"] }), d);
    await handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: "not an array" }), d);
    expect(frames().length).toBe(before);
  });

  it("caps how many screens one request may ask for", async () => {
    let asked: string[] = [];
    const { ws } = fakeSocket({ token: "good" });
    const d = deps({
      previewsFor: async (_u, ids) => {
        asked = ids;
        return new Map();
      },
    });
    await handleLiveOpen(ws, d);
    const many = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    await handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: many }), d);
    expect(asked.length).toBe(MAX_PREVIEW_REQUEST);
  });

  it("answers nothing for a socket that never opened", async () => {
    const { ws, frames } = fakeSocket({});
    const d = deps({ previewsFor: async () => new Map([["a", ["x"]]]) });
    await handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: ["a"] }), d);
    expect(frames()).toEqual([]);
  });
});
