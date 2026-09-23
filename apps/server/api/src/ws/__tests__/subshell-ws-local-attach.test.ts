import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { runMigrations } from "@/db/migrate.js";
import { getRequestlessContext } from "@/lib/context.js";
import { getDefaultLocalLauncher } from "@/services/nodes/local-launcher.js";

const defaultLocalLauncher = getDefaultLocalLauncher();

import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { attachUrlFromQuery } from "@/ws/attach-params.js";
import { cleanupSubshellWs, handleSubshellMessage, handleSubshellWs } from "@/ws/subshell-ws.js";
import { paneStreams, resetLiveViewersForTests, sharedGridFor, type WsSocket } from "@/ws/viewers.js";
import { issueWsToken } from "@/ws/ws-token.js";

/**
 * Local-attach cleanup leak (pre-Task-11, surfaced while reviewing §6.5).
 *
 * `handleSubshellWs` copied the attach state onto `ws.data` with
 * `Object.assign` BEFORE `startLogTail`/`startPanePoll` assigned
 * `data.cleanup` onto the local object — so `ws.data.cleanup` stayed
 * undefined, `cleanupSubshellWs(ws)` released nothing on disconnect, and
 * every local terminal attach leaked a live fs.watcher plus its
 * backstop/poll timer for the process lifetime.
 *
 * These tests drive the REAL handler through the REAL seams (issued WS
 * token, DB row via the shared test context, real fs.watch on the subshell
 * log file) and pin the behavior the leak broke: after `cleanupSubshellWs`
 * the stream is dead — no post-disconnect output frames, no pane captures
 * — and `ws.data.cleanup`, the contract `cleanupSubshellWs` consumes, is a
 * wired function. The remote relay was always correct (it installs
 * `cleanup` into `data` before its `Object.assign`); the local twin was not.
 */

// The handler resolves the local launcher via `launcherFor(LOCAL_NODE_ID)` —
// the module-level `defaultLocalLauncher`. Its tmux-touching methods are
// stubbed as OWN properties (the tmux CLI is not a `bun test` dependency)
// and restored per test; every other seam (fs.watch, the tail pump, the
// poll timer, the WS-token flow, the DB) runs for real.
const launcherOriginals = {
  hasSubshell: defaultLocalLauncher.hasSubshell,
  capture: defaultLocalLauncher.capture,
  resize: defaultLocalLauncher.resize,
  paneSize: defaultLocalLauncher.paneSize,
  signalPaneWinch: defaultLocalLauncher.signalPaneWinch,
};
/** Counts `capture` calls — the pane-poll branch's observable heartbeat. */
let captureCalls = 0;
/** What `capture` was last asked for (scrollback line budget), and call order markers. */
let captureLinesArg: number | undefined;
let resizeCalls: Array<{ cols: number; rows: number }> = [];
/** Shared per-test ordered log — proves resize lands BEFORE the capture. */
let order: string[] = [];

function stubLauncher(): void {
  defaultLocalLauncher.hasSubshell = async (_socket: string, _id: string) => true;
  defaultLocalLauncher.capture = async (_socket: string, _id: string, lines?: number) => {
    captureCalls += 1;
    captureLinesArg = lines;
    order.push("capture");
    return "SCREEN";
  };
  defaultLocalLauncher.resize = async (_socket: string, _id: string, cols: number, rows: number) => {
    resizeCalls.push({ cols, rows });
    order.push("resize");
  };
  // Default: the machine cannot deliver a bare SIGWINCH (as for a remote
  // node today), so the nudge path under test is the ±1 resize. Its
  // no-reflow-first behavior gets its own cases below.
  // Unreadable BY DEFAULT, and deliberately so: the real `paneSize` shells out
  // to tmux against a socket that does not exist, which happened to answer
  // null and left every case on the no-geometry path by accident — with the
  // attach's `geometry` frame silently never firing under test, and the file's
  // own "the tmux CLI is not a bun test dependency" claim quietly broken.
  // Cases that want the frame override this.
  defaultLocalLauncher.paneSize = async () => null;
  defaultLocalLauncher.signalPaneWinch = async () => {
    order.push("winch");
    return false;
  };
}

afterEach(() => {
  // Before the stubs are restored: a live poller must not survive into the
  // next test, and cleanupSubshellWs is idempotent, so cases that already
  // release their own socket are unaffected.
  for (const fake of attached.splice(0)) cleanupSubshellWs(fake.ws);
  defaultLocalLauncher.hasSubshell = launcherOriginals.hasSubshell;
  defaultLocalLauncher.capture = launcherOriginals.capture;
  defaultLocalLauncher.resize = launcherOriginals.resize;
  defaultLocalLauncher.paneSize = launcherOriginals.paneSize;
  defaultLocalLauncher.signalPaneWinch = launcherOriginals.signalPaneWinch;
  captureCalls = 0;
  captureLinesArg = undefined;
  resizeCalls = [];
  order = [];
  resetLiveViewersForTests();
});

let rowSeq = 0;

/** Seeds a live local subshell row (owner = a fresh synthetic user). */
async function seedLocalRow() {
  const { repos } = getRequestlessContext();
  rowSeq += 1;
  return repos.subshells.create({
    id: crypto.randomUUID(),
    userId: `u-ws-leak-${rowSeq}`,
    presetId: "p-test",
    harnessId: "shell",
    name: "ws-leak-regression",
    workingDir: "/tmp",
    tmuxSocket: "subshell-ws-leak-test",
  });
}

interface FakeBrowser {
  ws: WsSocket;
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

/** A fake browser socket with `ws.data` as a SEPARATE object (as Elysia's is). */
function fakeBrowser(): FakeBrowser {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws = {
    data: {},
    send: (d: string) => {
      sent.push(d);
      return 0;
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
    raw: {},
  } as unknown as WsSocket;
  return { ws, sent, closed };
}

/** Runs the real handler with a real single-use WS token (+ optional query, e.g. `&cols=132&rows=43`). */
/**
 * Every browser this file attaches, so `afterEach` can release it.
 *
 * An attach arms a stream that OUTLIVES the test: the log-tail branch leaves
 * an fs watcher plus a 1s backstop interval, and the pane-poll branch a 300ms
 * capture loop. Both keep calling the STUBBED launcher, and the stubs push
 * into module-level recorders (`order`, `captureCalls`) that the next test
 * reassigns and then asserts on — so a leaked poller from an earlier case
 * spilled extra "capture" entries into a later one's expectations, the more
 * of them the busier the machine. That is what made these cases pass alone
 * and fail under a full-suite run.
 */
const attached: FakeBrowser[] = [];

async function attach(userId: string, subshellId: string, extraQuery = ""): Promise<FakeBrowser> {
  const url = new URL(`ws://localhost/ws/subshell?subshell=${subshellId}&token=${issueWsToken(userId)}${extraQuery}`);
  const fake = fakeBrowser();
  await handleSubshellWs(fake.ws, url);
  attached.push(fake);
  return fake;
}

beforeAll(async () => {
  await runMigrations(); // the row insert + persistOutput's update hit the shared temp DB
});

describe("local attach cleanup — the ws.data wiring (pre-existing leak)", () => {
  it("the tail disposer is reachable on ws.data after attach — the contract cleanupSubshellWs consumes", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n"); // log exists ⇒ startLogTail branch

    const { ws, sent, closed } = await attach(row.userId, row.id);
    try {
      expect(closed).toEqual([]); // the attach ran to completion (not a refusal)
      expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
      // RED today: Object.assign ran before startLogTail set `data.cleanup` on
      // the local object, so ws.data never received the disposer and a
      // disconnect releases the watcher/timer by accident of nothing running.
      expect(typeof (ws.data as { cleanup?: unknown }).cleanup).toBe("function");
    } finally {
      cleanupSubshellWs(ws); // if wired (GREEN), releases the watcher+timer; if leaked, test 2 catches it
    }
  });

  it("a disconnect stops the stream: bytes appended after cleanup never ship", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "old\n");

    const { ws, sent } = await attach(row.userId, row.id);
    await Bun.sleep(60); // let the initial catch-up pump's frames land
    cleanupSubshellWs(ws); // browser disconnects
    const framesAtDisconnect = sent.length;

    appendFileSync(logFile, "after disconnect\n");
    await Bun.sleep(1300); // the fs.watch fires ~instantly; the 1000ms backstop covers twice
    // RED today: the watcher and its timer outlived the disconnect and stream
    // the appended bytes on the dead socket.
    expect(sent.slice(framesAtDisconnect)).toEqual([]);
  });

  it("a SECOND attach joins instead of evicting: both viewers get the same bytes", async () => {
    // This is the behaviour 4003 used to forbid. Eviction existed because one
    // tmux pane has one width and two viewers asserting their own sizes
    // thrashed it (the 2026-09-01 jumble) — that is now answered by deciding
    // the grid from the whole viewer set (`resolveSharedGrid`) rather than by
    // throwing a viewer off, so a subshell can be watched from two devices.
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "old\n");

    const first = await attach(row.userId, row.id);
    await Bun.sleep(60); // first viewer settles into its tail
    const second = await attach(row.userId, row.id);

    expect(first.closed).toEqual([]); // nobody is thrown off any more

    appendFileSync(logFile, "for both viewers\n");
    await Bun.sleep(1300); // watch fires ~instantly; backstop twice
    // BYTE-IDENTICAL, because one shared pump feeds both — two independent
    // pumps would each observe their own instant and drift apart.
    expect(first.sent.some((f) => f.includes("for both viewers"))).toBe(true);
    expect(second.sent.some((f) => f.includes("for both viewers"))).toBe(true);
    cleanupSubshellWs(first.ws);
    cleanupSubshellWs(second.ws);
  });

  it("forgets a viewer that disconnects, and lets the pane grow back", async () => {
    // Found by driving two real browser tabs and closing one: the pane stayed
    // at the departed viewer's size forever. The registry was keyed by SOCKET
    // IDENTITY, and Elysia hands `close` a different wrapper object than
    // `open` — so the delete silently missed, every disconnected viewer stayed
    // in the set, and the pane was pinned to the smallest device that had
    // EVER attached. The presence list filled with ghosts for the same reason.
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      order.push("resize");
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const tall = await attach(row.userId, row.id, "&cols=100&rows=50");
    const short = await attach(row.userId, row.id, "&cols=100&rows=30");
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 30 }); // smallest wins

    cleanupSubshellWs(short.ws); // the short viewer leaves
    await Bun.sleep(50);

    // The pane grows back to what the remaining viewer can show.
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 });

    // ...and the departed viewer is gone from presence, not a ghost.
    const latest = tall.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { viewers: unknown[] })
      .at(-1);
    expect(latest?.viewers).toHaveLength(1);

    cleanupSubshellWs(tall.ws);
  });

  it("a close that lands DURING the attach leaves no ghost viewer and no running pump", async () => {
    // `open` fires `void handleSubshellWs(...)` unawaited and `close` calls
    // `cleanupSubshellWs` regardless of how far the attach has got. Everything
    // the cleanup needs — `viewerId`, `cleanup` — only exists after
    // `Object.assign(ws.data, data)`, and the attach awaits an access lookup
    // and a tmux probe before reaching it. A close in that window found an
    // empty `ws.data`, deleted nothing, and disarmed nothing; the attach then
    // carried on and registered a viewer for a socket that was already gone
    // and would never fire `close` again.
    //
    // Under the old one-viewer rule the next attach evicted that ghost. Now
    // it is permanent: it holds a place in the shared-grid decision, so every
    // other device's pane stays sized for a viewer nobody is looking at, and
    // its subscription keeps the pane's pump running with no reader.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const fake = fakeBrowser();
    attached.push(fake);
    // A capacity on the URL, so a ghost would actually DECIDE something: this
    // is the damage, not the map entry.
    const url = new URL(
      `ws://localhost/ws/subshell?subshell=${row.id}&token=${issueWsToken(row.userId)}&cols=40&rows=12`,
    );
    const attaching = handleSubshellWs(fake.ws, url);
    // Mid-flight, before the attach can have assigned ws.data.
    cleanupSubshellWs(fake.ws);
    await attaching;

    expect(sharedGridFor(row.id)).toBeNull(); // no ghost in the sizing decision
    expect(paneStreams.viewerCount(row.id)).toBe(0); // and no pump left running
  });

  it("nudges around the SHARED fit, never the joiner's own size", async () => {
    // The nudge ENDS by resizing the pane to the size it is handed (it steps
    // ±1 and back) and seeds the queue with it, so handing it the joiner's
    // size silently undid the shared fit applied moments earlier. An
    // incumbent at 122x49 was left rendering a pane a 122x52 joiner had
    // claimed, clipping every later frame, with nothing scheduled to
    // re-decide it.
    //
    // The geometry change lives on the INCUMBENT now (the pane waits at 52
    // rows): a same-size reopen stopped nudging entirely, so the joiner at
    // the shared grid contributes no resize at all — which is itself half of
    // what this pins.
    stubLauncher();
    let paneRows = 52;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 122, rows: paneRows });
    // No SIGWINCH route and no log growth: the geometry nudge is forced.
    defaultLocalLauncher.signalPaneWinch = async () => false;
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const incumbent = await attach(row.userId, row.id, "&cols=122&rows=49");
    const incumbentDance = resizeCalls.length;
    expect(incumbentDance).toBeGreaterThan(0); // the incumbent resized (and stepped)

    const joiner = await attach(row.userId, row.id, "&cols=122&rows=52");

    // Whatever the nudge stepped through, the pane must END at the shared
    // grid — the size BOTH viewers can display — not the joiner's 52.
    expect(resizeCalls.at(-1)).toEqual({ cols: 122, rows: 49 });
    expect(resizeCalls.some((c) => c.rows === 52)).toBe(false);
    // And the joiner dragged nothing: the pane already displayed the shared
    // grid, so its reopen was untouched.
    expect(resizeCalls.length).toBe(incumbentDance);

    cleanupSubshellWs(joiner.ws);
    cleanupSubshellWs(incumbent.ws);
  });

  it("skips the winch storm for a RESTARTED row inside its boot grace (residual log + fresh startedAt)", async () => {
    // The local twin of the relay's wiring pins. `paneReadsAsBooting` is
    // unit-pure and pinned there; THIS case pins that the local attach
    // actually passes `row.startedAt` to it — drop the argument and every
    // other suite stays green while a second boot takes the storm again.
    // A restart reuses the row and the log survives on purpose, so the
    // residual 4 bytes plus a fresh boot timestamp must read as booting:
    // exactly ONE resize (the fit), no winch, no ±1 step.
    stubLauncher();
    let paneRows = 52; // differs from the join size, so the fit resize really fires
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    // No SIGWINCH route: settled here means the ±1 nudge below the winch
    // attempt — the very provocation this fast path exists to skip. The push
    // keeps "did the storm even start" observable.
    defaultLocalLauncher.signalPaneWinch = async () => {
      order.push("winch");
      return false;
    };
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");
    const { repos } = getRequestlessContext();
    await repos.subshells.update(row.id, { startedAt: new Date().toISOString() });

    const viewer = await attach(row.userId, row.id, "&cols=100&rows=50");

    expect(resizeCalls).toEqual([{ cols: 100, rows: 50 }]);
    expect(order).not.toContain("winch");

    cleanupSubshellWs(viewer.ws);
  });

  it("clears a pin when the device it names leaves", async () => {
    // `decideSharedGrid` already falls through to auto for a pin it cannot
    // resolve, so the pane is never wrong — but the policy still rides the
    // presence frame, and the UI faithfully reported "pinned" plus a "Back to
    // automatic" for a pin that had not been in effect since that tab closed.
    // A control that lies about the state it controls is worse than none.
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const phone = await attach(row.userId, row.id, "&cols=100&rows=20");
    const laptopId = (
      JSON.parse(laptop.sent.filter((f) => f.includes('"type":"viewers"')).at(-1) ?? "{}") as {
        you: string;
      }
    ).you;

    handleSubshellMessage(phone.ws, JSON.stringify({ type: "set-sizing", mode: "pinned", viewerId: laptopId }));
    await Bun.sleep(60);
    const pinned = JSON.parse(phone.sent.filter((f) => f.includes('"type":"viewers"')).at(-1) ?? "{}") as {
      sizing: { mode: string; pinnedViewerId: string | null };
    };
    expect(pinned.sizing).toEqual({ mode: "pinned", pinnedViewerId: laptopId });

    cleanupSubshellWs(laptop.ws); // the pinned device closes its tab
    await Bun.sleep(60);

    const after = JSON.parse(phone.sent.filter((f) => f.includes('"type":"viewers"')).at(-1) ?? "{}") as {
      sizing: { mode: string; pinnedViewerId: string | null };
    };
    expect(after.sizing).toEqual({ mode: "auto", pinnedViewerId: null });

    cleanupSubshellWs(phone.ws);
  });

  it("re-decides the grid once the attach is over, so a raced resize is not lost", async () => {
    // The attach resizes the pane DIRECTLY (it must be awaited before the
    // capture) and seeds the queue behind its back, so it can interleave with
    // a concurrent `requestPaneResize` from another viewer: the queue applies
    // the newer shared grid and records it, this attach's seed overwrites the
    // record, and the repaint nudge returns the pane to the attach's own fit.
    // The pane is then left at a size the viewer set does not call for, with
    // nothing scheduled to notice.
    //
    // Driven here through the front door: a second viewer whose capacity the
    // attach could not have seen, applied while the attach is still running.
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const first = await attach(row.userId, row.id, "&cols=100&rows=50");
    // A second viewer that can only show 30 rows. Whatever order the attach
    // and this frame interleave in, the pane must END at the shared minimum.
    const second = await attach(row.userId, row.id, "&cols=100&rows=30");
    handleSubshellMessage(second.ws, JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await Bun.sleep(80);

    expect(sharedGridFor(row.id)).toEqual({ cols: 100, rows: 30 });
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 30 });

    cleanupSubshellWs(second.ws);
    cleanupSubshellWs(first.ws);
  });

  it("honours `&hidden=1` from the connect URL, without waiting for a frame", async () => {
    // The client's on-open `visibility` frame races this handler's own awaits
    // and is DROPPED when it wins (`handleSubshellMessage` returns while
    // `ws.data` is still empty). Capacity survives that race because it is
    // re-sent on every resize; `visibility` is sent once and then only on
    // change, so a tab attached while already hidden would have held every
    // other device's pane at its size for the socket's whole life.
    stubLauncher();
    let paneRows = 60; // differs from both viewers, so the laptop's fit RESIZES —
    // otherwise a silent no-op would pass "takes no part" for the wrong reason.
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const resizedByLaptop = resizeCalls.length;
    const pocketed = await attach(row.userId, row.id, "&cols=100&rows=20&hidden=1");

    // The hidden joiner takes no part: the pane stays at the laptop's size.
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 });
    expect(resizeCalls.some((c) => c.rows === 20)).toBe(false);
    expect(resizeCalls.length).toBe(resizedByLaptop);
    const presence = laptop.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { viewers: Array<{ hidden: boolean; capacity: { rows: number } | null }> })
      .at(-1);
    expect(presence?.viewers.find((v) => v.capacity?.rows === 20)?.hidden).toBe(true);

    cleanupSubshellWs(pocketed.ws);
    cleanupSubshellWs(laptop.ws);
  });

  it("tells the INCUMBENT when a smaller joiner shrinks the pane under it", async () => {
    // Found by driving two real browser tabs. The pane correctly took the
    // minimum, and the joiner rendered it — but the incumbent was never told,
    // so it kept painting the taller grid it had arrived with. A client and a
    // pane that disagree by even one row is the whole reason this work exists.
    //
    // The attach applies the shared fit DIRECTLY (it must be awaited before
    // the capture) rather than through the geometry queue, so the queue's own
    // announcement does not cover this path.
    stubLauncher();
    let paneRows = 52;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      order.push("resize");
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 122, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const incumbent = await attach(row.userId, row.id, "&cols=122&rows=52");
    const geometryIn = (frames: string[]) =>
      frames
        .filter((f) => f.includes('"type":"geometry"'))
        .map((f) => {
          const { cols, rows } = JSON.parse(f) as { cols: number; rows: number };
          return { cols, rows };
        });
    expect(geometryIn(incumbent.sent).at(-1)).toEqual({ cols: 122, rows: 52 });

    // A shorter viewer joins: smallest-wins takes the pane to 49 rows.
    const joiner = await attach(row.userId, row.id, "&cols=122&rows=49");

    expect(geometryIn(joiner.sent).at(-1)).toEqual({ cols: 122, rows: 49 });
    // ...and the incumbent is TOLD, rather than left painting 52 rows.
    expect(geometryIn(incumbent.sent).at(-1)).toEqual({ cols: 122, rows: 49 });

    cleanupSubshellWs(incumbent.ws);
    cleanupSubshellWs(joiner.ws);
  });

  it("hands the pane back when the small viewer is HIDDEN, and takes it again when shown", async () => {
    // A backgrounded tab is not laid out at all, so it cannot re-fit — and
    // pinning everyone else's terminal to phone size with nothing on screen to
    // explain it is indistinguishable from a bug.
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const phone = await attach(row.userId, row.id, "&cols=100&rows=20");
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 20 });

    handleSubshellMessage(phone.ws, JSON.stringify({ type: "visibility", hidden: true }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 }); // laptop gets it back

    handleSubshellMessage(phone.ws, JSON.stringify({ type: "visibility", hidden: false }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 20 }); // and loses it again

    cleanupSubshellWs(laptop.ws);
    cleanupSubshellWs(phone.ws);
  });

  it("a pinned viewer decides the grid, and a `view` grantee cannot pin", async () => {
    stubLauncher();
    let paneRows = 50;
    defaultLocalLauncher.resize = async (_s: string, _i: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      paneRows = rows;
    };
    defaultLocalLauncher.paneSize = async () => ({ cols: 100, rows: paneRows });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const laptop = await attach(row.userId, row.id, "&cols=100&rows=50");
    const phone = await attach(row.userId, row.id, "&cols=100&rows=20");
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 20 });

    // Pin the laptop: it decides alone, even though it is the larger.
    const laptopId = (laptop.ws.data as { viewerId: string }).viewerId;
    handleSubshellMessage(laptop.ws, JSON.stringify({ type: "set-sizing", mode: "pinned", viewerId: laptopId }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 });

    // The policy is announced, so a client can render which device is driving.
    const latest = phone.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { sizing: { mode: string; pinnedViewerId: string | null } })
      .at(-1);
    expect(latest?.sizing).toEqual({ mode: "pinned", pinnedViewerId: laptopId });

    // A read-only viewer cannot change what everyone sees.
    (phone.ws.data as { canInput: boolean }).canInput = false;
    const phoneId = (phone.ws.data as { viewerId: string }).viewerId;
    handleSubshellMessage(phone.ws, JSON.stringify({ type: "set-sizing", mode: "pinned", viewerId: phoneId }));
    await Bun.sleep(50);
    expect(resizeCalls.at(-1)).toEqual({ cols: 100, rows: 50 }); // unchanged

    cleanupSubshellWs(laptop.ws);
    cleanupSubshellWs(phone.ws);
  });

  it("tells every viewer who else is watching, and which entry is itself", async () => {
    // A pane has one grid and the SMALLEST viewer decides it, so "why is my
    // terminal this size?" is only answerable if a client can see the other
    // devices — and it can only answer "is that me?" with `you`.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const first = await attach(row.userId, row.id, "&cols=120&rows=40&device=Laptop");
    const second = await attach(row.userId, row.id, "&cols=80&rows=24&device=Phone");

    const presenceOf = (frames: string[]) =>
      frames
        .filter((f) => f.includes('"type":"viewers"'))
        .map((f) => JSON.parse(f) as { you: string; viewers: Array<{ id: string; label: string }> })
        .at(-1);

    const asSeenBySecond = presenceOf(second.sent);
    expect(asSeenBySecond?.viewers.map((v) => v.label).sort()).toEqual(["Laptop", "Phone"]);

    // The first viewer is TOLD about the joiner — presence is pushed, not polled.
    const asSeenByFirst = presenceOf(first.sent);
    expect(asSeenByFirst?.viewers.map((v) => v.label).sort()).toEqual(["Laptop", "Phone"]);

    // Each is pointed at its own entry, and they are different entries.
    const meForFirst = asSeenByFirst?.viewers.find((v) => v.id === asSeenByFirst.you);
    const meForSecond = asSeenBySecond?.viewers.find((v) => v.id === asSeenBySecond.you);
    expect(meForFirst?.label).toBe("Laptop");
    expect(meForSecond?.label).toBe("Phone");
    expect(asSeenByFirst?.you).not.toBe(asSeenBySecond?.you);

    cleanupSubshellWs(first.ws);
    cleanupSubshellWs(second.ws);
  });

  it("reports each viewer's capacity, which is what explains the shared grid", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const first = await attach(row.userId, row.id, "&cols=120&rows=40&device=Laptop");
    const second = await attach(row.userId, row.id, "&cols=80&rows=24&device=Phone");

    const latest = second.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map(
        (f) => JSON.parse(f) as { viewers: Array<{ label: string; capacity: { cols: number; rows: number } | null }> },
      )
      .at(-1);
    const byLabel = Object.fromEntries((latest?.viewers ?? []).map((v) => [v.label, v.capacity]));
    expect(byLabel.Laptop).toEqual({ cols: 120, rows: 40 });
    expect(byLabel.Phone).toEqual({ cols: 80, rows: 24 });
    // ...and the pane took the smaller of them.
    expect(resizeCalls.at(-1)).toEqual({ cols: 80, rows: 24 });

    cleanupSubshellWs(first.ws);
    cleanupSubshellWs(second.ws);
  });

  it("normalizes a hand-built device label rather than trusting it", async () => {
    // The label is rendered in another viewer's browser and written to a log
    // line; the client's own sanitizing protects nothing against a crafted
    // socket URL.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "old\n");

    const viewer = await attach(row.userId, row.id, `&device=${encodeURIComponent("Evil\r\nX-Injected: 1")}`);
    const latest = viewer.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { viewers: Array<{ label: string }> })
      .at(-1);
    expect(latest?.viewers[0]?.label).toBe("Evil X-Injected: 1");

    cleanupSubshellWs(viewer.ws);
  });

  it("the last viewer leaving stops the stream; one remaining viewer keeps it", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "old\n");

    const first = await attach(row.userId, row.id);
    const second = await attach(row.userId, row.id);
    await Bun.sleep(60);

    cleanupSubshellWs(first.ws); // one leaves
    const firstFrames = first.sent.length;
    appendFileSync(logFile, "still streaming\n");
    await Bun.sleep(1300);
    expect(first.sent.slice(firstFrames)).toEqual([]); // the one who left is silent
    expect(second.sent.some((f) => f.includes("still streaming"))).toBe(true); // the other is not

    cleanupSubshellWs(second.ws); // the last one leaves
    const secondFrames = second.sent.length;
    appendFileSync(logFile, "after everyone left\n");
    await Bun.sleep(1300);
    expect(second.sent.slice(secondFrames)).toEqual([]);
  });

  it("the pane-poll branch: cleanup clears the poll interval — no captures after disconnect", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    // No log file at subshellLogPath(row.id) ⇒ the handler takes startPanePoll.

    const { ws } = await attach(row.userId, row.id);
    try {
      expect(typeof (ws.data as { cleanup?: unknown }).cleanup).toBe("function");
      await Bun.sleep(700); // ≥ 2 ticks of the 300ms poller
      expect(captureCalls).toBeGreaterThan(1); // replay capture + poll ticks ran
      cleanupSubshellWs(ws);
      // Snapshot AFTER a short settle. Clearing the interval cannot recall a
      // tick that already fired and is awaiting its capture, so reading the
      // counter in the same breath as the disconnect races that in-flight
      // call and blames it on the interval. What must be true is that no
      // FURTHER ticks arrive, which the 700ms window below (>2 ticks) proves.
      await Bun.sleep(50);
      const capturesAtDisconnect = captureCalls;
      await Bun.sleep(700);
      // RED today: the interval never cleared — the poller captures the pane
      // forever after the browser left.
      expect(captureCalls).toBe(capturesAtDisconnect);
    } finally {
      cleanupSubshellWs(ws);
    }
  });
});

describe("local attach replay — one clean paint, no raw-log re-play", () => {
  it("history never ships as raw log bytes: the tail starts at the log's size when the replay was taken", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "HISTORY-LINES\r\n"); // pre-existing raw output

    const { sent } = await attach(row.userId, row.id);
    // ONLY the replay frame: the whole "replay last N raw log lines over the
    // capture grid" mechanism is gone (it painted mid-stream TUI redraw
    // sequences over the snapshot — the jumble that took ~10s to converge and
    // left the oldest scrollback lines garbled forever).
    // Terminal frames only: the socket also carries `viewers` presence now.
    expect(sent.filter((f) => !f.includes('"type":"viewers"'))).toEqual([
      JSON.stringify({ type: "replay", data: "SCREEN" }),
    ]);

    // New output AFTER the attach still streams — EOF is a start, not a stop.
    appendFileSync(logFile, "live\r\n");
    // POLL. Only Linux's inotify fires "~instantly"; macOS coalesces FSEvents,
    // so this frame can arrive on the 1000ms backstop instead — which is why
    // every other wait in this file allows 1300ms. A fixed 120ms made the case
    // pass in CI and fail on a Mac.
    const terminalFrames = () => sent.filter((f) => !f.includes('"type":"viewers"'));
    const deadline = Date.now() + 5000;
    while (terminalFrames().length < 2 && Date.now() < deadline) await Bun.sleep(25);
    expect(terminalFrames()[1]).toBe(JSON.stringify({ type: "output", data: "live\r\n" }));
  });

  it("announces the pane's REAL grid BEFORE the replay, so the capture paints onto an agreed grid", async () => {
    // The capture is taken at whatever the pane actually holds, which is not
    // necessarily what the client asked for on the URL (tmux can clamp it, or
    // the request can be lost). Telling the client first means it paints the
    // replay onto a grid it already agrees with instead of discovering the
    // mismatch a frame later — and the ORDER is the whole point.
    stubLauncher();
    defaultLocalLauncher.paneSize = async () => ({ cols: 132, rows: 43 });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    const { sent } = await attach(row.userId, row.id, "&cols=132&rows=43");

    expect(sent[0]).toBe(JSON.stringify({ type: "geometry", cols: 132, rows: 43 }));
    expect(sent[1]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
  });

  it("announces the pane's size even when tmux did not take the client's request", async () => {
    // The measured defect: the browser asked 51x13 and the pane sat at 51x16.
    // The client must be told 16 — an echo of its own request would be
    // indistinguishable from a confirmation and defeats the readback.
    stubLauncher();
    defaultLocalLauncher.paneSize = async () => ({ cols: 51, rows: 16 });
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    const { sent } = await attach(row.userId, row.id, "&cols=51&rows=13");

    expect(sent[0]).toBe(JSON.stringify({ type: "geometry", cols: 51, rows: 16 }));
  });

  it("announces NO geometry for a pane whose size cannot be read (remote nodes)", async () => {
    // RemoteLauncher answers null rather than echoing the request, which keeps
    // those clients on the pre-readback behavior instead of trusting a guess.
    stubLauncher(); // paneSize defaults to null
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    const { sent } = await attach(row.userId, row.id, "&cols=80&rows=24");

    expect(sent.some((f) => f.includes('"type":"geometry"'))).toBe(false);
    expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
  });

  it("the replay ships CRLF rows — a bare LF froze a staircase into scrollback", async () => {
    // `capture-pane -p` separates rows with a BARE LF and emits no CR at all.
    // LF moves the cursor down but keeps the COLUMN, so xterm started each
    // row where the previous one ended (mod the width) — the reported
    // diagonal staircase of half-drawn tables. It only showed when scrolling
    // UP because the app's live diffs repaint the visible grid with absolute
    // positioning, while nothing ever rewrites scrollback.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");
    const grid = "┌────────┐\n│ row  1 │\n│ row  2 │\n└────────┘";
    defaultLocalLauncher.capture = async () => grid;

    const { sent } = await attach(row.userId, row.id);
    const frame = JSON.parse(sent[0]) as { type: string; data: string };
    expect(frame.type).toBe("replay");
    expect(frame.data).toBe("┌────────┐\r\n│ row  1 │\r\n│ row  2 │\r\n└────────┘");
    expect(/[^\r]\n/.test(frame.data)).toBe(false); // no bare LF anywhere
  });

  it("the replay capture carries the per-subshell line budget (default 100)", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");
    await attach(row.userId, row.id);
    expect(captureLinesArg).toBe(100); // TERMINAL_REPLAY_LINES default
  });

  it("the plugin's query→URL handoff keeps cols/rows alive (regression: they were stripped)", async () => {
    // Mirror the EXACT production path: ws.plugin reads ws.data.query and
    // rebuilds the URL via attachUrlFromQuery. A version of it re-picked only
    // subshell+token — dropping the geometry — so pin the round trip here.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    const fake = fakeBrowser();
    await handleSubshellWs(
      fake.ws,
      attachUrlFromQuery({ subshell: row.id, token: issueWsToken(row.userId), cols: "132", rows: "43" }),
    );
    // Geometry survived the handoff. Only the FIRST resize is asserted: the
    // stubbed pane never repaints, so the repaint nudge follows it (pinned by
    // its own case below).
    expect(resizeCalls[0]).toEqual({ cols: 132, rows: 43 });
  });

  it("cols/rows on the URL resize the pane BEFORE the capture — replay matches client geometry", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    await attach(row.userId, row.id, "&cols=132&rows=43");
    expect(resizeCalls[0]).toEqual({ cols: 132, rows: 43 });
    expect(order[0]).toBe("resize"); // nothing reads the pane before the resize lands
    // ONE capture, and it comes LAST — the gap-free byte stream (join point
    // before the resize) corrects any frame the snapshot raced, so the old
    // stable-grid poll is gone. The resizes ahead of it are the geometry fit
    // plus the repaint nudge (own case below).
    expect(order.filter((o) => o === "capture")).toEqual(["capture"]);
    expect(order.at(-1)).toBe("capture");
  });

  it("the capture waits for the post-resize REPAINT (log burst), not a flat timer", async () => {
    // tmux re-wraps the OLD frame the instant the pane resizes, so a
    // settle-timer capture can ship a stable-looking grid of mid-word
    // garbage while the app's SIGWINCH repaint is still in flight — the
    // "jumbled until you resize" report. The repaint shows up as fresh
    // bytes in the pane log; the attach must wait for that burst. Here the
    // repaint lands 350 ms after the resize — AFTER the old flat 150 ms
    // settle — and only a repaint-aware capture sees FRESH.
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "x\n");
    let repainted = false;
    defaultLocalLauncher.resize = async () => {
      order.push("resize");
      setTimeout(() => {
        appendFileSync(logFile, "repaint-bytes\n"); // the app's SIGWINCH repaint arrives
        repainted = true;
      }, 350);
    };
    defaultLocalLauncher.capture = async () => {
      order.push("capture");
      captureCalls += 1;
      return repainted ? "FRESH" : "STALE";
    };

    const { sent } = await attach(row.userId, row.id, "&cols=100&rows=30");
    expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "FRESH" }));
  });

  it("a pane that never repaints is NUDGED (±1 col) to force a SIGWINCH before the capture", async () => {
    // THE standing bug (2026-09-01): reopening a subshell at the size the pane
    // already has makes `resize-window` a no-op, so no SIGWINCH fires, so a
    // diff-rendering TUI never repaints — and whatever half-repainted frame
    // the pane was left holding is what the capture ships, forever, for every
    // later viewer. That is why "close subshell, re-enter, still garbled" while a
    // manual window resize fixes it for good. The attach must force the
    // repaint itself: bump the width one column and step back.
    stubLauncher(); // stub resize writes nothing to the log ⇒ no repaint burst
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    await attach(row.userId, row.id, "&cols=80&rows=24");

    // Fit, nudge out, nudge back — and the pane ends at the client's real size.
    // (The winch ran first and was refused — the stub says "this machine
    // cannot signal the pane" — so the ±1 fallback is what these calls are.)
    expect(resizeCalls).toEqual([
      { cols: 80, rows: 24 },
      { cols: 81, rows: 24 },
      { cols: 80, rows: 24 },
    ]);
    expect(order.at(-1)).toBe("capture"); // the capture reads the post-nudge frame
    expect(order.indexOf("winch")).toBeLessThan(order.indexOf("capture", order.lastIndexOf("resize"))); // winch precedes the fallback
  });

  it("a pane that answers the bare SIGWINCH is NOT nudged — no ±1 reflow of its history", async () => {
    // The ±1 resize forces the repaint the reopen needs, but each step makes
    // tmux REFLOW the pane's history — and a phone that reattaches every
    // minute was stamping duplicate blocks into scrollback that nothing can
    // ever rewrite (2026-09-04: "still garbled when I scroll up"). The
    // geometry-free route — SIGWINCH to the pane's process — must be tried
    // FIRST, and succeed the attach when the app answers it.
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "x\n");
    let repainted = false;
    defaultLocalLauncher.signalPaneWinch = async () => {
      order.push("winch");
      // The signal lands; the app's repaint follows ~a frame later, as bytes
      // the size probe can catch growing (the wait samples the log at call
      // time, so writing synchronously here would be invisible to it).
      setTimeout(() => {
        appendFileSync(logFile, "winch-repaint\n");
        repainted = true;
      }, 60);
      return true;
    };
    defaultLocalLauncher.capture = async () => {
      order.push("capture");
      return repainted ? "FRESH" : "STALE";
    };

    const { sent } = await attach(row.userId, row.id, "&cols=80&rows=24");

    expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "FRESH" }));
    // The fit only — the width never moved, so the history never reflowed.
    expect(resizeCalls).toEqual([{ cols: 80, rows: 24 }]);
    // Collapse runs of the same op: what this pins is the ORDER — the fit,
    // then the geometry-free winch, then the capture — not how many captures
    // the attach took. Capture counts track machine load here (the replay
    // path re-reads the pane while it waits for the repaint), so an exact
    // array failed a correct implementation whenever the box was busy. A
    // capture BEFORE the winch, or a second resize, still fails: the ±1
    // nudge this test exists to forbid would show up as a second "resize",
    // and `resizeCalls` above independently pins the width to one fit.
    const collapsed = order.filter((op, i) => op !== order[i - 1]);
    expect(collapsed).toEqual(["resize", "winch", "capture"]);
  });

  it("a SIGWINCH the app ignores still falls through to the ±1 nudge", async () => {
    // "Signal delivered" is not "pane repainted": an app that only redraws
    // when the size actually CHANGES stays silent on a same-size winch, and
    // the attach must not ship its half-painted frame — the fallback nudge
    // keeps the pre-winch behavior as the floor.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");
    defaultLocalLauncher.signalPaneWinch = async () => {
      order.push("winch");
      return true; // delivered, and nothing ever answers it (stub resize writes no bytes)
    };

    await attach(row.userId, row.id, "&cols=80&rows=24");

    expect(resizeCalls).toEqual([
      { cols: 80, rows: 24 },
      { cols: 81, rows: 24 },
      { cols: 80, rows: 24 },
    ]);
  });

  it("a pane that DOES repaint is not nudged — no gratuitous geometry thrash", async () => {
    // The nudge is a repair, not a ritual: when the resize already produced
    // the app's repaint burst, the capture is of a fresh frame and touching
    // the geometry again would only re-wrap it (and cost a round trip).
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "x\n");
    defaultLocalLauncher.resize = async (_socket: string, _id: string, cols: number, rows: number) => {
      resizeCalls.push({ cols, rows });
      order.push("resize");
      // The app answers the SIGWINCH promptly, as a burst of log bytes.
      appendFileSync(logFile, "full-repaint\n");
    };

    await attach(row.userId, row.id, "&cols=90&rows=30");

    expect(resizeCalls).toEqual([{ cols: 90, rows: 30 }]); // fit only — no nudge
  });

  it("without cols/rows the capture runs exactly once (no quiesce for stale clients)", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    await attach(row.userId, row.id);
    expect(captureCalls).toBe(1);
  });

  it("no log file ⇒ no nudge: the repaint signal is blind, so the pane is left alone", async () => {
    // Without a log, the size probe reads 0 forever and "no burst" means
    // "nothing to detect with", not "the pane refused to repaint" — nudging
    // on that would thrash the geometry of every pane-poll attach for no
    // evidence at all.
    stubLauncher();
    const row = await seedLocalRow();
    // No file at subshellLogPath(row.id) ⇒ the handler takes startPanePoll.

    const { ws } = await attach(row.userId, row.id, "&cols=100&rows=30");
    try {
      expect(resizeCalls).toEqual([{ cols: 100, rows: 30 }]); // the fit, and nothing more
    } finally {
      cleanupSubshellWs(ws); // release the poll interval
    }
  });

  it("a malformed cols/rows pair skips the resize without failing the attach", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), "x\n");

    const { sent, closed } = await attach(row.userId, row.id, "&cols=abc&rows=0");
    expect(resizeCalls).toEqual([]);
    expect(closed).toEqual([]);
    expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
  });

  it("a client that closes DURING the attach's awaits leaves nothing armed", async () => {
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "x\n");

    // resize + settle + quiet-poll span ~250 ms; the close lands mid-await.
    const url = new URL(`ws://localhost/ws?subshell=${row.id}&token=${issueWsToken(row.userId)}&cols=100&rows=30`);
    const fake = fakeBrowser();
    const attaching = handleSubshellWs(fake.ws, url);
    await Bun.sleep(30);
    cleanupSubshellWs(fake.ws); // browser vanishes before the tail ever arms
    await attaching;

    const framesAtAttach = fake.sent.length;
    appendFileSync(logFile, "after close\n");
    await Bun.sleep(1300); // watch would fire ~instantly; the backstop twice
    expect(fake.sent.slice(framesAtAttach)).toEqual([]); // no watcher/timer survived
  });
});
