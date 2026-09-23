import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANE_LOG_FILE_FLAG, TmuxRunner, tmuxSocketFor } from "@internal/pane-runtime";
import { LocalLauncher } from "@/services/nodes/local-launcher.js";
import { fitPaneAndRepaint } from "@/ws/pane-repaint.js";

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

describe("fitPaneAndRepaint", () => {
  it("an animating pane: sees the repaint and returns without waiting for a quiet that never comes", async () => {
    const p = await seed("anim-same", SPINNER);
    try {
      const t0 = performance.now();
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, p.size, p.sizeOf, {
        baseline: await p.sizeOf(),
        canNudge: true,
      });
      expect(performance.now() - t0).toBeLessThan(600);
      expect(r.repainted).toBe(true);
    } finally {
      await p.dispose();
    }
  });

  it("a same-size reopen skips the no-op resize wait: the pane cannot repaint for a resize that changes nothing", async () => {
    const p = await seed("idle-same", "cat");
    try {
      const t0 = performance.now();
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, p.size, p.sizeOf, {
        baseline: await p.sizeOf(),
        canNudge: true,
      });
      // A pane that never repaints (cat) still ends nudged — that behaviour is
      // kept — but no longer after 450ms spent waiting on a no-op resize first.
      expect(performance.now() - t0).toBeLessThan(600);
      expect(r.nudged).toBe(true);
      expect(r.repainted).toBe(false);
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

  it("a booting pane (zero log bytes) gets the fit resize and NO winch storm", async () => {
    // The fresh-terminal duplicate-prompt report (2026-09-23): attach fires
    // while the shell is still booting, and the nudge's ±1 geometry steps make
    // slow-init prompts (ble.sh, powerlevel10k) redraw THEMSELVES INTO HISTORY
    // — the stray prompt at the top of an empty pane. With `booting`, the one
    // fit resize happens (before any frame exists, so the shell boots AT the
    // fit geometry) and nothing else.
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
      // The same call without `booting` spends ≥200ms waiting for a burst a
      // silent pane cannot send, then nudges; this path is one resize RPC.
      expect(performance.now() - t0).toBeLessThan(150);
      expect(await launcher.paneSize(p.socket, p.id)).toEqual(fit);
      // And the pane stayed untouched: no winch-provoked bytes.
      expect(await p.sizeOf()).toBe(0);
    } finally {
      await p.dispose();
    }
  });

  it("canNudge:false never nudges (a pane-poll attach has no log to read a burst from)", async () => {
    const p = await seed("nonudge", "cat");
    try {
      const r = await fitPaneAndRepaint(launcher, p.socket, p.id, p.size, p.sizeOf, {
        baseline: await p.sizeOf(),
        canNudge: false,
      });
      expect(r).toEqual({ repainted: false, nudged: false });
    } finally {
      await p.dispose();
    }
  });
});
