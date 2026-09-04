import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { runMigrations } from "@/db/migrate.js";
import { getRequestlessContext } from "@/lib/context.js";
import { getDefaultLocalLauncher } from "@/services/nodes/local-launcher.js";

const defaultLocalLauncher = getDefaultLocalLauncher();

import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import {
  attachUrlFromQuery,
  cleanupSubshellWs,
  handleSubshellWs,
  resetLiveViewersForTests,
  type WsSocket,
} from "@/ws/subshell-ws.js";
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
  signalPaneWinch: defaultLocalLauncher.signalPaneWinch,
  paneCursor: defaultLocalLauncher.paneCursor,
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
  defaultLocalLauncher.signalPaneWinch = async () => {
    order.push("winch");
    return false;
  };
  // Default: no cursor answer (the remote node's shape today) ⇒ the attach
  // skips the quiet join and replays with the overlap, exactly as the suites
  // here were written. The quiet-join cases stub a cursor.
  defaultLocalLauncher.paneCursor = async () => null;
}

afterEach(() => {
  defaultLocalLauncher.hasSubshell = launcherOriginals.hasSubshell;
  defaultLocalLauncher.capture = launcherOriginals.capture;
  defaultLocalLauncher.resize = launcherOriginals.resize;
  defaultLocalLauncher.signalPaneWinch = launcherOriginals.signalPaneWinch;
  defaultLocalLauncher.paneCursor = launcherOriginals.paneCursor;
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
    profileId: "p-test",
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
async function attach(userId: string, subshellId: string, extraQuery = ""): Promise<FakeBrowser> {
  const url = new URL(`ws://localhost/ws/subshell?subshell=${subshellId}&token=${issueWsToken(userId)}${extraQuery}`);
  const fake = fakeBrowser();
  await handleSubshellWs(fake.ws, url);
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

  it("a NEW attach replaces the previous viewer: the old socket closes 4003 and goes silent", async () => {
    // One tmux pane has one width; two viewers at different widths thrash it
    // and shatter the TUI (2026-09-01 jumble). Newest attach wins, and the
    // replaced socket must stop streaming immediately — its watcher/timer,
    // not just its close event.
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "old\n");

    const first = await attach(row.userId, row.id);
    await Bun.sleep(60); // first viewer settles into its tail
    const second = await attach(row.userId, row.id); // newer viewer takes over

    expect(first.closed.some((c) => c.code === 4003)).toBe(true);
    const firstFrames = first.sent.length;

    appendFileSync(logFile, "for the new owner\n");
    await Bun.sleep(1300); // watch fires ~instantly; backstop twice
    expect(first.sent.slice(firstFrames)).toEqual([]); // evicted: nothing more ships
    expect(second.sent.some((s) => s.includes("for the new owner"))).toBe(true);
    cleanupSubshellWs(second.ws);
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
    expect(sent).toEqual([JSON.stringify({ type: "replay", data: "SCREEN" })]);

    // New output AFTER the attach still streams — EOF is a start, not a stop.
    appendFileSync(logFile, "live\r\n");
    await Bun.sleep(120); // fs.watch fires ~instantly
    expect(sent[1]).toBe(JSON.stringify({ type: "output", data: "live\r\n" }));
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
    expect(order).toEqual(["resize", "winch", "capture"]);
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

  it("a quiet window joins AT the snapshot: the cursor rides the replay, painted bytes are never re-sent", async () => {
    // The 2026-09-04 garble fix. When the pane pauses across one capture
    // window, the snapshot provably contains everything the log holds at
    // that offset — so the tail starts THERE (no overlap for the app's next
    // repaint to erase lines from) and the pane's cursor is restored with a
    // CUP the client simply writes. Output that lands BETWEEN the join sample
    // and the snapshot is painted-in-grid content: it must never arrive as an
    // output frame on top of the fresh capture.
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "already-painted\r\n");
    defaultLocalLauncher.paneCursor = async () => ({ x: 4, y: 9 });
    let firstCapture = true;
    defaultLocalLauncher.capture = async () => {
      if (firstCapture) {
        firstCapture = false;
        appendFileSync(logFile, "between-join-and-snapshot\r\n"); // in the grid the capture reports
      }
      return "SCREEN";
    };

    const { sent } = await attach(row.userId, row.id, "&cols=80&rows=24");
    expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN\x1b[10;5H" }));
    expect(sent.some((f) => f.includes("between-join-and-snapshot"))).toBe(false);

    appendFileSync(logFile, "live\r\n"); // output AFTER the join streams normally
    await Bun.sleep(120);
    expect(sent.some((f) => f.includes("live"))).toBe(true);
  });

  it("a pane that never pauses falls back to the overlap join — replay without a cursor, bytes unskipped", async () => {
    // A capture window that never comes quiet (constant animation) cannot
    // prove the snapshot's offset, so the attach must degrade to the OLD
    // join — visible transient beats a skipped byte forever.
    stubLauncher();
    const row = await seedLocalRow();
    const logFile = subshellLogPath(row.id);
    await Bun.write(logFile, "x\r\n");
    defaultLocalLauncher.paneCursor = async () => ({ x: 0, y: 0 });
    defaultLocalLauncher.capture = async () => {
      appendFileSync(logFile, "busy\r\n"); // the log grows DURING every attempt
      return "SCREEN";
    };

    const { sent } = await attach(row.userId, row.id, "&cols=80&rows=24");
    const frame = JSON.parse(sent[0]) as { type: string; data: string };
    expect(frame.data).toBe("SCREEN"); // no CUP suffix — overlap semantics
    // Bytes written mid-attach ride the stream (the join predates the capture):
    await Bun.sleep(120);
    expect(sent.some((f) => f !== sent[0] && f.includes("busy"))).toBe(true);
  }, 15_000);

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
