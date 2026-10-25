import { describe, expect, it } from "bun:test";
import {
  type NodeCommandBody,
  type NodeEvent,
  PREVIEW_STREAM_DEBT_MAX,
  PREVIEW_WATCH_SUBSCRIBERS_MAX,
  type PreviewStreamFrame,
} from "@internal/subshell-protocol";
import { getPreviewBroker, resetForTests } from "@/services/preview-broker.js";
import { sendPreviewStreamSocket, sendToSockets } from "@/ws/live-registry.js";
import { EVERYONE_TOPIC, userTopic } from "@/ws/live-topics.js";
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
function fakeSocket(query: Record<string, string> = {}, raw: unknown = { getBufferedAmount: () => 0 }) {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const subscribed: string[] = [];
  const data: LiveWsSocket["data"] = { query };
  let readyState = 1; // OPEN
  // `raw` is the SAME instance in both wrappers, as in production: the socket
  // the watch adapter hands the broker reads its byte debt through it, so a
  // double that fakes the raw socket per-wrapper would miss exactly the
  // property the adapter exists to carry.
  const wrapper = (): LiveWsSocket => ({
    data,
    raw,
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
    consumeToken: (t) => (t === "good" ? { userId: "u1", subshellId: null } : null),
    listSubshells: async () => [{ id: "s1" }] as never,
    previewsFor: async () => new Map(),
    // The re-ask (disable race): healthy by default, like the token the
    // factory hands out. Individual cases flip it.
    accountDisabled: async () => false,
    passwordChangeRequired: async () => false,
    // The `watch` gate asks one question; the healthy answer by default is
    // this socket's owner watching their own pane. Rows that probe the gate
    // flip it (a `view` grant, a foreign `none`).
    accessFor: async () => "owner",
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

  it("refuses a SCOPED token — a Bearer-key mint never reaches the whole-user feed", async () => {
    // The mint route binds every machine token to one subshell id; this
    // socket is the second half of that contract. The refusal is the SAME
    // close a bad token gets — a scoped token tells a stranger nothing new.
    const { ws, sent, closed, subscribed } = fakeSocket({ token: "scoped" });
    await handleLiveOpen(ws, deps({ consumeToken: () => ({ userId: "u1", subshellId: "s1" }) }));
    expect(sent).toEqual([]);
    expect(subscribed).toEqual([]);
    expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
  });

  it("refuses a token whose owner was disabled between the mint and this redeem", async () => {
    // The disable race `attach-resolve` documents: a mint passes `authGuard`,
    // the disable commits, `dropUserTokensFor` walks the store — an insert
    // landing after that walk survives the sweep for its 30 s, and the
    // feed-socket sweep ran before this socket existed. The redemption
    // re-asks the FLAG, which cannot be beaten; the refusal is the uniform
    // bad-token pair, so a disable never reads as an enumeration signal.
    const { ws, sent, closed, subscribed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, deps({ accountDisabled: async () => true }));
    expect(sent).toEqual([]);
    expect(subscribed).toEqual([]);
    expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
  });

  it("refuses human feed access while a restored password change is required", async () => {
    const { ws, sent, closed, subscribed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, deps({ passwordChangeRequired: async () => true }));
    expect(sent).toEqual([]);
    expect(subscribed).toEqual([]);
    expect(closed).toEqual([{ code: 4001, reason: "unauthorized" }]);
  });

  it("fails closed when restored-password state cannot be checked", async () => {
    const { ws, sent, closed } = fakeSocket({ token: "good" });
    await handleLiveOpen(
      ws,
      deps({
        passwordChangeRequired: async () => {
          throw new Error("unavailable");
        },
      }),
    );
    expect(sent).toEqual([]);
    expect(closed).toEqual([{ code: 1011, reason: "open failed" }]);
  });

  it("fails the re-ask CLOSED — an unreadable account state closes, and the reconnect re-mints through the guard", async () => {
    // A throw must not leave the socket streaming: unlike a node socket (the
    // next dial re-asks at the upgrade gate), a live feed is never re-checked
    // after it opens, so a kept socket here keeps a missed disable for the
    // tab's whole life. Closing costs the healthy an ordinary reconnect — the
    // mint route is the same question's other door.
    const { ws, sent, closed } = fakeSocket({ token: "good" });
    await handleLiveOpen(
      ws,
      deps({
        accountDisabled: async () => {
          throw new Error("db transient");
        },
      }),
    );
    expect(sent).toEqual([]);
    expect(closed).toEqual([{ code: 1011, reason: "open failed" }]);
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

  it("the open path reads no role at all (2026-10-09): the deps carry no isAdmin", async () => {
    // The admins topic and the role read died together - the feed's audience
    // is owner + grantees, and a viewer's pair is [own, everyone] whatever
    // their role. This deps object is the real LiveWsDeps shape: if a role
    // read ever returns to the open path, this literal stops type-checking.
    const { ws, subscribed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, deps());
    expect(subscribed).toEqual([userTopic("u1"), EVERYONE_TOPIC]);
  });

  /**
   * A socket that never delivered its snapshot must not sit open. The client
   * marks itself connected only once one lands, and nothing else will arrive
   * to change that — so an open-but-silent socket reads as permanently offline
   * with no reconnect scheduled, because no close ever fired.
   */
  it("closes when the snapshot read fails, so the client's backoff can retry", async () => {
    const { ws, sent, closed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, deps({ listSubshells: () => Promise.reject(new Error("db hiccup")) }));
    expect(sent).toEqual([]);
    expect(closed.length).toBe(1);
    // Below 4000: a retryable drop, not a refusal the client should report.
    expect(closed[0]?.code).toBeLessThan(4000);
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

describe("/ws/live bounded work and resync", () => {
  it("answers a resync with a fresh snapshot", async () => {
    const { ws, frames } = fakeSocket({ token: "good" });
    const d = deps();
    await handleLiveOpen(ws, d);
    await handleLiveMessage(ws, JSON.stringify({ type: "resync" }), d);
    expect(frames().filter((f) => f.type === "snapshot").length).toBe(2);
  });

  /**
   * Each id is a `capture-pane` spawn. A client re-asking while the last answer
   * is still being produced — a filter being typed, a burst of changes — would
   * otherwise multiply that by however many requests are in flight.
   */
  it("serves one capture run at a time, dropping an overlapping ask", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { ws } = fakeSocket({ token: "good" });
    const d = deps({
      previewsFor: async () => {
        runs += 1;
        await gate;
        return new Map();
      },
    });
    await handleLiveOpen(ws, d);
    const first = handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: ["a"] }), d);
    await handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: ["b"] }), d);
    expect(runs).toBe(1);
    release();
    await first;
    // Once it settles the socket accepts again — the guard is per request, not a latch.
    await handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: ["c"] }), d);
    expect(runs).toBe(2);
  });

  it("stops sending screens if the socket closed while they were being captured", async () => {
    const { ws, closeWs, frames } = fakeSocket({ token: "good" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const d = deps({
      previewsFor: async () => {
        await gate;
        return new Map([
          ["a", ["screen a"]],
          ["b", ["screen b"]],
        ]);
      },
    });
    await handleLiveOpen(ws, d);
    const pending = handleLiveMessage(ws, JSON.stringify({ type: "previews", ids: ["a", "b"] }), d);
    handleLiveClose(closeWs);
    release();
    await pending;
    expect(frames().filter((f) => f.type === "preview")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* watch/unwatch: the screencast fan-out wired through the broker      */
/* ------------------------------------------------------------------ */

/**
 * Rebuilds the broker over fake node seams with the REAL fan-out sender
 * installed (`sendPreviewStreamSocket`, the very function `live-ws.ts` wires
 * at module init). Passing the seam explicitly keeps every row below
 * deterministic no matter which sender won the process-global boot slot in
 * a serial run: what these rows exercise is the real broker mechanics and
 * the real serialization, driven through the real handler.
 */
function fakePreviewNode(accessFor?: LiveWsDeps["accessFor"]): { commands: NodeCommandBody[] } {
  const commands: NodeCommandBody[] = [];
  resetForTests({
    send: async (_nodeId: string, cmd: NodeCommandBody): Promise<unknown> => {
      commands.push(cmd);
      if (cmd.type === "preview_open") return { ref: cmd.ref, subscribers: 1 };
      if (cmd.type === "preview_close") return { ref: cmd.ref, closed: true };
      return {};
    },
    sendToSockets: sendPreviewStreamSocket,
    accessFor,
  });
  return { commands };
}

/** The pane's live screencast bridge, built the way the REST watch path builds it. */
async function openBridge(paneId: string, nodeId = "n-fake"): Promise<string> {
  const broker = getPreviewBroker();
  await broker.startWatch({ viewerUserId: "u1", paneId, nodeId, port: 9222 });
  const ref = broker.sessionForPane(paneId)?.ref;
  if (!ref) throw new Error(`bridge for ${paneId} did not stand`);
  return ref;
}

function streamEvent(ref: string, seq: number): Extract<NodeEvent, { type: "preview_stream" }> {
  return { type: "preview_stream", ref, seq, w: 64, h: 32, ts: 1_780_000_000_000 + seq, blob: `blob-${seq}` };
}

function streamFrames(sent: string[]): Record<string, unknown>[] {
  return sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.type === "preview-stream");
}

describe("/ws/live watch subscriptions", () => {
  it("refuses a disabled account before its live socket has been closed", async () => {
    fakePreviewNode();
    const ref = await openBridge("p-1");
    let disabled = false;
    const d = deps({ accountDisabled: async () => disabled });
    const { ws, closeWs, sent } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, d);
    disabled = true;
    await handleLiveMessage(ws, JSON.stringify({ type: "watch", id: "p-1" }), d);
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));
    try {
      expect(streamFrames(sent)).toEqual([]);
    } finally {
      handleLiveClose(closeWs);
    }
  });

  it("stops retrying when revocation repeatedly overtakes the access check", async () => {
    fakePreviewNode();
    const ref = await openBridge("p-1");
    let asked = 0;
    const d = deps({
      accessFor: async () => {
        asked++;
        await getPreviewBroker().closeUnauthorizedForPane("another-pane");
        return "view";
      },
    });
    const { ws, closeWs, sent } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, d);
    await handleLiveMessage(ws, JSON.stringify({ type: "watch", id: "p-1" }), d);
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));
    try {
      expect(streamFrames(sent)).toEqual([]);
      expect(asked).toBe(3);
    } finally {
      handleLiveClose(closeWs);
    }
  });

  for (const cut of ["share", "user"] as const) {
    it(`rechecks a pending stream subscription after ${cut} revocation`, async () => {
      let allowed = true;
      fakePreviewNode(async (userId) => (userId === "u1" && !allowed ? "none" : "owner"));
      const ref = await openBridge("p-1");
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let asked = 0;
      const d = deps({
        accessFor: async () => {
          asked++;
          const answer = allowed ? "view" : "none";
          if (asked === 1) {
            entered();
            await gate;
          }
          return answer;
        },
      });
      const { ws, closeWs, sent } = fakeSocket({ token: "good" });
      await handleLiveOpen(ws, d);
      const pending = handleLiveMessage(ws, JSON.stringify({ type: "watch", id: "p-1" }), d);
      await started;
      allowed = false;
      if (cut === "share") await getPreviewBroker().closeUnauthorizedForPane("p-1");
      else await getPreviewBroker().closeAllForUser("u1", "revoked");
      release();
      await pending;
      getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));
      try {
        expect(streamFrames(sent)).toEqual([]);
        expect(asked).toBe(2);
      } finally {
        handleLiveClose(closeWs);
      }
    });
  }

  it("a watch from a view grant attaches the socket; frames arrive with the blob untouched, and only there", async () => {
    fakePreviewNode();
    const ref = await openBridge("p-1");
    // Two sockets of the SAME holder (both redeem to u1): only the first
    // sends `watch`, so only the first may receive.
    const watcher = fakeSocket({ token: "good" });
    const sibling = fakeSocket({ token: "good" });
    const d = deps({ accessFor: async () => "view" });
    await handleLiveOpen(watcher.ws, d);
    await handleLiveOpen(sibling.ws, d);
    await handleLiveMessage(watcher.ws, JSON.stringify({ type: "watch", id: "p-1" }), d);

    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));

    expect(streamFrames(watcher.sent)).toEqual([
      { type: "preview-stream", id: "p-1", seq: 1, w: 64, h: 32, blob: "blob-1" },
    ]);
    expect(streamFrames(sibling.sent)).toEqual([]);
    handleLiveClose(watcher.closeWs);
    handleLiveClose(sibling.closeWs);
  });

  it("a watch the access check fails attaches nothing and never closes the socket", async () => {
    fakePreviewNode();
    const ref = await openBridge("p-foreign");
    const asked: string[] = [];
    const d = deps({
      accessFor: async (_u, paneId) => {
        asked.push(paneId);
        return "none";
      },
    });
    const { ws, closeWs, sent, closed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, d);
    // Spy straight at the broker: the check must be the last thing standing
    // between a stranger and the stream set.
    const broker = getPreviewBroker();
    const realAttach = broker.attachStream;
    const attached: string[] = [];
    broker.attachStream = (paneId, socketKey, holderUserId, socket) => {
      attached.push(paneId);
      return realAttach(paneId, socketKey, holderUserId, socket);
    };

    await handleLiveMessage(ws, JSON.stringify({ type: "watch", id: "p-foreign" }), d);
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));

    expect(asked).toEqual(["p-foreign"]); // the gate was asked
    expect(attached).toEqual([]); // and refused: nothing reached the broker
    expect(streamFrames(sent)).toEqual([]);
    expect(closed).toEqual([]); // invisible reads as silence, never as a refusal
    handleLiveClose(closeWs);
  });

  it("unwatch stops delivery and leaves the socket open", async () => {
    fakePreviewNode();
    const ref = await openBridge("p-1");
    const d = deps();
    const { ws, closeWs, sent, closed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, d);
    await handleLiveMessage(ws, JSON.stringify({ type: "watch", id: "p-1" }), d);
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));
    expect(streamFrames(sent)).toHaveLength(1);

    await handleLiveMessage(ws, JSON.stringify({ type: "unwatch", id: "p-1" }), d);
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 2));

    expect(streamFrames(sent)).toHaveLength(1); // seq 2 never arrived
    expect(closed).toEqual([]);
    handleLiveClose(closeWs);
  });

  /**
   * THE swapped-wrapper pin. Elysia hands `close` a fresh `ElysiaWS` that
   * shares `data` with the one `open` got (the file-header measurement), so
   * a stream registry keyed by the SOCKET OBJECT would find nothing here and
   * leak the entry for the pane's life. This double builds a fresh wrapper
   * per call exactly like the adapter does: closing through `closeWs` (never
   * the `ws` that attached) must still detach.
   */
  it("closing through the swapped wrapper detaches every pane; the holder's other socket is unaffected", async () => {
    fakePreviewNode();
    const refA = await openBridge("p-a");
    const refB = await openBridge("p-b");
    const d = deps();
    const a = fakeSocket({ token: "good" });
    const b = fakeSocket({ token: "good" });
    await handleLiveOpen(a.ws, d);
    await handleLiveOpen(b.ws, d);
    for (const pane of ["p-a", "p-b"]) {
      await handleLiveMessage(a.ws, JSON.stringify({ type: "watch", id: pane }), d);
      await handleLiveMessage(b.ws, JSON.stringify({ type: "watch", id: pane }), d);
    }
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(refA, 1));
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(refB, 1));
    expect(streamFrames(a.sent)).toHaveLength(2);
    expect(streamFrames(b.sent)).toHaveLength(2);

    // Close socket a through the wrapper it never attached with.
    handleLiveClose(a.closeWs);

    getPreviewBroker().onStreamEvent("n-fake", streamEvent(refA, 2));
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(refB, 2));
    expect(streamFrames(a.sent)).toHaveLength(2); // both panes detached by one close
    expect(streamFrames(b.sent)).toHaveLength(4); // sibling untouched, both panes still flowing
    handleLiveClose(b.closeWs);
  });

  it("byte debt on one socket detaches THAT socket through the raw-socket adapter; bridge and lane stay untouched", async () => {
    const node = fakePreviewNode();
    const ref = await openBridge("p-1");
    const d = deps();
    // The lagging socket's raw reports debt above the cap; the handler's
    // adapter must read the METHOD off `raw` (the wrapper carries neither
    // property nor method - Task 8's measurement is why this exists at all).
    const slow = fakeSocket({ token: "good" }, { getBufferedAmount: () => PREVIEW_STREAM_DEBT_MAX + 1 });
    const fast = fakeSocket({ token: "good" });
    await handleLiveOpen(slow.ws, d);
    await handleLiveOpen(fast.ws, d);
    await handleLiveMessage(slow.ws, JSON.stringify({ type: "watch", id: "p-1" }), d);
    await handleLiveMessage(fast.ws, JSON.stringify({ type: "watch", id: "p-1" }), d);

    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));
    expect(streamFrames(slow.sent)).toEqual([]); // dropped before its frame was sent
    expect(streamFrames(fast.sent)).toHaveLength(1);

    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 2));
    // Still silent. This row cannot tell "detached" from "skipped again"
    // while the debt stays over cap; the deletion itself is pinned by the
    // broker's viewer_drop row in preview-broker.test.ts.
    expect(streamFrames(slow.sent)).toEqual([]);
    expect(streamFrames(fast.sent)).toHaveLength(2);

    // The drop is viewer-side only: the bridge still stands and the wire saw
    // no close of anything (spec §9 drops slow viewers, never the bridge).
    expect(getPreviewBroker().sessionForPane("p-1")).not.toBeNull();
    expect(node.commands.filter((c) => c.type === "preview_close")).toEqual([]);
    handleLiveClose(slow.closeWs);
    handleLiveClose(fast.closeWs);
  });

  /**
   * The ninth socket's experience is the dark canvas: the attach cap refuses
   * with a VALUE plus an audit row (both Task 8's), and this row pins the
   * handler's half: the refusal is swallowed. Not thrown, not a close, not a
   * registration.
   */
  it("a watch the attach cap refuses leaves the socket open and unregistered", async () => {
    fakePreviewNode();
    const ref = await openBridge("p-1");
    const broker = getPreviewBroker();
    const quiet: string[] = [];
    for (let i = 0; i < PREVIEW_WATCH_SUBSCRIBERS_MAX; i += 1) {
      expect(broker.attachStream("p-1", `fill-${i}`, "u1", { send: (d) => quiet.push(d) })).toEqual({ ok: true });
    }
    const d = deps();
    const { ws, closeWs, sent, closed } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, d);

    await expect(handleLiveMessage(ws, JSON.stringify({ type: "watch", id: "p-1" }), d)).resolves.toBeUndefined();
    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));

    expect(streamFrames(sent)).toEqual([]); // unregistered: the pane's frames skip it
    expect(closed).toEqual([]); // and it stays open on the feed
    expect(quiet).toHaveLength(PREVIEW_WATCH_SUBSCRIBERS_MAX); // the eight it displaced keep streaming
    handleLiveClose(closeWs);
  });

  it("a watch that lands after the socket closed during the access check attaches nothing", async () => {
    // `liveStop` is the close marker: a close that lands while the gate's
    // await is in flight must not leave a dead socket in the stream set.
    fakePreviewNode();
    const ref = await openBridge("p-1");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const d = deps({
      accessFor: async () => {
        await gate;
        return "view";
      },
    });
    const { ws, closeWs, sent } = fakeSocket({ token: "good" });
    await handleLiveOpen(ws, d);
    const pending = handleLiveMessage(ws, JSON.stringify({ type: "watch", id: "p-1" }), d);
    handleLiveClose(closeWs);
    release();
    await pending;

    getPreviewBroker().onStreamEvent("n-fake", streamEvent(ref, 1));
    expect(streamFrames(sent)).toEqual([]);
  });
});

describe("live-registry preview fan-out primitives", () => {
  it("one send per socket, JSON-serialized in both shapes", () => {
    const frame: PreviewStreamFrame = { type: "preview-stream", id: "p", seq: 7, w: 4, h: 2, blob: "zz" };
    const a: string[] = [];
    const b: string[] = [];
    const sa = { send: (d: string) => a.push(d) };
    const sb = { send: (d: string) => b.push(d) };

    sendPreviewStreamSocket(sa, frame);
    sendToSockets([sa, sb], frame);

    expect(a).toEqual([JSON.stringify(frame), JSON.stringify(frame)]);
    expect(b).toEqual([JSON.stringify(frame)]);
  });
});
