import { describe, expect, it } from "bun:test";
import { TmuxRunner, tmuxSocketFor } from "@internal/pane-runtime";
import { LocalLauncher } from "@/services/nodes/local-launcher.js";
import { fitPaneAndRepaint } from "@/ws/pane-repaint.js";

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
  tmux.pipePane(socket, id, log);
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
