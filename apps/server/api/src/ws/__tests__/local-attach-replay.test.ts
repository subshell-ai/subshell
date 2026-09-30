import { describe, expect, it } from "bun:test";
import { appendFileSync } from "node:fs";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { attachUrlFromQuery } from "@/ws/attach-params.js";
import { cleanupSubshellWs, handleSubshellWs } from "@/ws/subshell-ws.js";
import { issueWsToken } from "@/ws/ws-token.js";
import {
  attach,
  bumpCaptureCalls,
  captureCalls,
  captureLinesArg,
  defaultLocalLauncher,
  fakeBrowser,
  order,
  resizeCalls,
  seedLocalRow,
  stubLauncher,
} from "./helpers/local-attach-harness.js";

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
      bumpCaptureCalls();
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
