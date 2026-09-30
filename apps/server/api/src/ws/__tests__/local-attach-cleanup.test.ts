import { describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { cleanupSubshellWs, handleSubshellWs } from "@/ws/subshell-ws.js";
import { paneStreams, sharedGridFor } from "@/ws/viewers.js";
import { issueWsToken } from "@/ws/ws-token.js";
import {
  attach,
  attached,
  defaultLocalLauncher,
  fakeBrowser,
  order,
  resizeCalls,
  seedLocalRow,
  stubLauncher,
} from "./helpers/local-attach-harness.js";

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

  it("waits for a fresh pane's log to appear and then TAILS it — not the whole-grid poll", async () => {
    // A terminal opened straight from CREATE attaches before pipe-pane's
    // child has even exec'd (measured: 4 ms on a local client). The decision
    // used to be made at that instant and stuck for the socket's life: no
    // log ⇒ pane-poll, which re-prints the ENTIRE grid each tick and strands
    // the client's cursor at the bottom while the prompt boots near the top
    // — the operator's "prompt at top, typing off-screen" (replay=78B of
    // blank). The wait catches the file moments later, and the tail then
    // carries the pane's real byte stream: distinguishable here because the
    // stubbed `capture` answers "SCREEN" — log bytes can only arrive via
    // the tail.
    stubLauncher();
    const row = await seedLocalRow(); // deliberately NO log file yet
    const attaching = attach(row.userId, row.id);
    await Bun.sleep(60); // …the pipe-pane child exec's, opening the log…
    await Bun.write(subshellLogPath(row.id), "boot frame\n");
    const { sent } = await attaching;

    appendFileSync(subshellLogPath(row.id), "typed echo\n");
    await Bun.sleep(1300); // fs.watch fires ~instantly; the backstop covers twice
    expect(sent.some((f) => f.includes("typed echo"))).toBe(true);
  });

  it("a booting viewer is not handed the boot bytes its replay already shows", async () => {
    // The ghost-prompt mechanism (browser-verified, 2026-09-23): a fresh
    // viewer joins at byte 0, receives a capture of the booted screen, and
    // THEN the queued boot stream — a shell's scroll-region/line-insert
    // prompt sequences are not idempotent re-applied, so the client paints a
    // SECOND prompt where its own cursor sits (the bottom). The booting
    // attach marks its queue before the capture; this pins both halves: the
    // bytes the capture subsumed are dropped, and bytes after the mark still
    // stream.
    stubLauncher();
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), ""); // live row, empty log ⇒ booting
    const attaching = attach(row.userId, row.id, "&cols=100&rows=50");
    await Bun.sleep(40); // the shell paints mid-dance…
    appendFileSync(subshellLogPath(row.id), "boot frame\n");
    const { sent } = await attaching; // …the watch sees it, the mark drops it

    appendFileSync(subshellLogPath(row.id), "live byte\n");
    await Bun.sleep(1300);
    expect(sent.some((f) => f.includes("boot frame"))).toBe(false);
    expect(sent.some((f) => f.includes("live byte"))).toBe(true);
  });

  it("a booting viewer whose capture FAILS is refused, not parked on a blank screen", async () => {
    // The boot drop promises the capture subsumes its queued bytes. When the
    // capture itself fails (pane died mid-attach, tmux hiccup) the promise is
    // void: opening would flush a DRAINED queue and the viewer would wait
    // forever for a replay that never comes. It gets the remote twin's
    // refusal instead — stream torn down, 4004, which the client treats as
    // retryable, so a transient tmux failure reconnects rather than
    // dead-ending the panel. (A NON-booting viewer still streams on a null
    // capture: it kept its queue — the local path's long-standing swallow.)
    stubLauncher();
    defaultLocalLauncher.capture = async () => {
      throw new Error("tmux went away mid-attach");
    };
    const row = await seedLocalRow();
    await Bun.write(subshellLogPath(row.id), ""); // live row, empty log ⇒ booting
    const viewer = await attach(row.userId, row.id, "&cols=100&rows=50");
    expect(viewer.closed).toEqual([{ code: 4004, reason: "subshell not running" }]);
    expect(viewer.sent.some((f) => f.includes('"type":"replay"'))).toBe(false);
  });

  it("still falls back to pane-poll when the log never appears at all", async () => {
    // The wait is bounded so a row whose log genuinely never shows (swept,
    // hand-deleted) attaches rather than hangs — and the poll fallback still
    // feeds the viewer the grid.
    stubLauncher();
    const row = await seedLocalRow();
    const t0 = performance.now();
    const viewer = await attach(row.userId, row.id);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1000); // it waited
    expect(viewer.closed).toEqual([]); // …then attached, not refused
    await Bun.sleep(700); // at least one poll tick beyond the first frame
    expect(viewer.sent.some((f) => f.includes('"type":"output"'))).toBe(true);
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
});
