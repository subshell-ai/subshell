import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANE_LOG_FILE_FLAG, TmuxRunner, tmuxSocketFor } from "@internal/pane-runtime";
import { LocalLauncher } from "@/services/nodes/local-launcher.js";
import { fitPaneAndRepaint, paneReadsAsBooting, STARTUP_GRACE_MS } from "@/ws/pane-repaint.js";

// Arm `pipe-pane` with a streaming capture child (the real production child is
// the self-invoked `pane-log` verb). A bare `cat >>` is what froze the live
// view on hosts whose `cat` is uutils coreutils, and this repaint test watches
// log GROWTH — so on such a host the cat child would never flush the spinner
// and the test would hang/fail for reasons unrelated to the repaint dance. The
// child is `bun <shim> pane-log --file <path>`, resolved to the running bun.
const PANLOG_SHIM = join(tmpdir(), `subshell-repaint-shim-${process.pid}.ts`);
// Resolve the package to its on-disk module (from /tmp a bare specifier would
// not resolve); a file: URL becomes an absolute path Bun can import.
const PANLOG_MOD = import.meta.resolve("@internal/pane-runtime").replace(/^file:\/\//, "");
writeFileSync(
  PANLOG_SHIM,
  `import { appendStdinToLogFile } from ${JSON.stringify(PANLOG_MOD)};\n` +
    `const a = process.argv.slice(2);\nappendStdinToLogFile(a[a.indexOf(${JSON.stringify(PANE_LOG_FILE_FLAG)}) + 1]);\n`,
);
const panlogChild = { command: process.execPath, args: [PANLOG_SHIM, "pane-log"] };

/**
 * The attach's fit-then-repaint dance, against REAL panes.
 *
 * This is the wall-clock a person waits when a subshell opens or reattaches.
 * It used to be 1.2–1.5s on every attach, measured with these same functions:
 * a heuristic sized for a TUI that repaints ONCE and goes quiet, applied to
 * panes that either animate forever (Claude Code's spinner never gives 150ms
 * of quiet, so the wait ran to its 1500ms deadline) or never repaint at all
 * (a plain shell burned every no-growth grace in sequence). Each case pins a
 * bound generously above what the path now costs and far below what it did.
 */
const launcher = new LocalLauncher();
const tmux = new TmuxRunner();
/** A spinner every 80ms — the cadence of a thinking agent's status line. */
const SPINNER = `sh -c 'while :; do for c in "|" "/" "-" "\\\\"; do printf "\\r%s thinking" "$c"; sleep 0.08; done; done'`;

async function seed(label: string, cmd: string) {
  const id = `repaint-${label}-${process.pid}`;
  const socket = tmuxSocketFor(id);
  tmux.newSubshell(socket, id, "/tmp", cmd);
  const log = launcher.logPath(id);
  tmux.pipePane(socket, id, log, panlogChild);
  await Bun.sleep(500);
  const size = await launcher.paneSize(socket, id);
  if (!size) throw new Error("pane has no size");
  const sizeOf = async () => (await Bun.file(log).stat()).size;
  const dispose = async () => {
    tmux.killSubshell(socket, id);
    await launcher.removeArtifacts([log]);
  };
  return { id, socket, size, sizeOf, dispose };
}

describe("paneReadsAsBooting", () => {
  const T = Date.parse("2026-09-23T12:00:00.000Z");
  const at = (msAgo: number) => new Date(T - msAgo).toISOString();

  it("zero bytes is booting whatever the age (first boot, or no log to read)", () => {
    expect(paneReadsAsBooting(0, null, T)).toBe(true);
    expect(paneReadsAsBooting(0, at(86_400_000), T)).toBe(true);
  });

  it("residual bytes inside the boot grace are a RESTART booting", () => {
    // The row reused its id and its log survived the restart on purpose;
    // `startedAt` is the only thing that says "this byte count is from the
    // PREVIOUS life".
    expect(paneReadsAsBooting(7, at(500), T)).toBe(true);
    expect(paneReadsAsBooting(7, at(STARTUP_GRACE_MS - 1), T)).toBe(true);
  });

  it("residual bytes past the grace, or no timestamp at all, are a settled pane", () => {
    expect(paneReadsAsBooting(7, at(STARTUP_GRACE_MS), T)).toBe(false);
    expect(paneReadsAsBooting(7, at(STARTUP_GRACE_MS + 60_000), T)).toBe(false);
    expect(paneReadsAsBooting(7, null, T)).toBe(false);
    expect(paneReadsAsBooting(7, "not-a-date", T)).toBe(false);
  });
});

describe("fitPaneAndRepaint", () => {
  it("an animating pane: sees the repaint and returns without waiting for a quiet that never comes", async () => {
    // A size CHANGE — the animating case is about detecting the repaint burst
    // a real resize provokes. (A same-size open of any pane now returns at
    // once, animated or not; the reopen case below pins that.)
    const p = await seed("anim-same", SPINNER);
    try {
      const t0 = performance.now();
      const fit = { cols: p.size.cols - 3, rows: p.size.rows };
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, fit, p.sizeOf, {
        baseline: await p.sizeOf(),
        canNudge: true,
      });
      expect(performance.now() - t0).toBeLessThan(600);
      expect(r.repainted).toBe(true);
    } finally {
      await p.dispose();
    }
  });

  it("a same-size reopen does nothing at all: no geometry changed, so nothing can be stale and every provocation is pure damage", async () => {
    const p = await seed("idle-same", "cat");
    try {
      const t0 = performance.now();
      const before = await p.sizeOf();
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, p.size, p.sizeOf, {
        baseline: before,
        canNudge: true,
      });
      // Used to skip only the no-op resize WAIT and still nudge — but a
      // same-size reopen re-wraps nothing, so the nudge corrects no stale
      // frame, and a SIGWINCH-redrawing prompt pays for it with an orphan
      // prompt line in its OWN history on every reopen (2026-09-23).
      expect(performance.now() - t0).toBeLessThan(300);
      expect(r).toEqual({ repainted: false, nudged: false });
      // Untouched: no winch bytes, and the pane is where it was.
      expect(await p.sizeOf()).toBe(before);
      expect(await launcher.paneSize(p.socket, p.id)).toEqual(p.size);
    } finally {
      await p.dispose();
    }
  });

  it("a size change on an idle pane still resizes, then nudges when nothing repaints", async () => {
    const p = await seed("idle-diff", "cat");
    try {
      const fit = { cols: p.size.cols - 3, rows: p.size.rows };
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, fit, p.sizeOf, {
        baseline: await p.sizeOf(),
        canNudge: true,
      });
      expect(r.nudged).toBe(true);
      // The nudge ends by putting the pane at the FIT size (see its ±1 step).
      expect(await launcher.paneSize(p.socket, p.id)).toEqual(fit);
    } finally {
      await p.dispose();
    }
  });

  it("a booting pane that never paints gets the fit resize, the capped watch, and NO winch storm", async () => {
    // The fresh-terminal duplicate-prompt report (2026-09-23): attach fires
    // while the shell is still booting, and the nudge's ±1 geometry steps make
    // slow-init prompts (ble.sh, powerlevel10k) redraw THEMSELVES INTO HISTORY
    // — the stray prompt at the top of an empty pane. With `booting`, the fit
    // resize happens (before any frame exists, so the shell boots AT the fit
    // geometry) and the passive first-paint watch runs, but NOTHING provokes.
    const p = await seed("boot-quiet", "sh -c 'sleep 30'");
    try {
      const fit = { cols: p.size.cols - 3, rows: p.size.rows };
      const t0 = performance.now();
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, fit, p.sizeOf, {
        baseline: 0,
        canNudge: true,
        booting: true,
      });
      expect(r).toEqual({ repainted: false, nudged: false });
      // The wait IS paid here on purpose (the no-growth budget, ≤200ms): an
      // immediate capture of a booting pane ships a blank grid and corrupts
      // the client's cursor base. The bound still discriminates against the
      // provocation path (fit-wait + winch + ±1 ≈ 520ms floor) while allowing
      // the watch + two tmux RPCs under CI load.
      expect(performance.now() - t0).toBeLessThan(500);
      expect(await launcher.paneSize(p.socket, p.id)).toEqual(fit);
      // And the pane stayed untouched: no winch-provoked bytes.
      expect(await p.sizeOf()).toBe(0);
    } finally {
      await p.dispose();
    }
  });

  it("a booting pane's FIRST PAINT is caught: the watch ends on it, so the capture is not blank", async () => {
    // The regression this watch exists for (dev server, 2026-09-23): a fast
    // path that skipped the wait captured 78 bytes of empty grid three ms
    // after pane birth; the prompt arrived later as live bytes, and the
    // client rendered prompt-at-top with its cursor stranded at the bottom.
    // A pane that paints within the budget must come back repainted=true.
    // `seed` already spent 500ms, so the paint is armed to land ~100ms INTO
    // the watch — growth observed, 60ms of quiet, return — well inside the
    // 200ms no-growth budget the silent case above pays instead.
    const p = await seed("boot-paint", "sh -c 'sleep 0.6; printf hello; sleep 30'");
    try {
      const before = await p.sizeOf();
      expect(before).toBe(0); // nothing painted yet — the blank-replay risk is live
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, p.size, p.sizeOf, {
        baseline: 0,
        canNudge: true,
        booting: true,
      });
      expect(r).toEqual({ repainted: true, nudged: false });
      expect(await p.sizeOf()).toBeGreaterThan(before);
    } finally {
      await p.dispose();
    }
  });

  it("canNudge:false resizes but never provokes (a REAL change waited on and got nothing)", async () => {
    // Must be a size CHANGE: a same-size fit now returns before the wait, and
    // the same-size version of this test passed through the new early return
    // without ever touching the guard (mutation-verified). This is the live
    // route to the flag — a viewer that detached (or has no readable log)
    // during the post-resize wait must not leave a ±1 storm behind.
    const p = await seed("nonudge", "cat");
    try {
      const fit = { cols: p.size.cols - 3, rows: p.size.rows };
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, fit, p.sizeOf, {
        baseline: await p.sizeOf(),
        canNudge: false,
      });
      expect(r).toEqual({ repainted: false, nudged: false });
      // The fit itself still applied — refusing to provoke never means refusing
      // to resize.
      expect(await launcher.paneSize(p.socket, p.id)).toEqual(fit);
    } finally {
      await p.dispose();
    }
  });
});
