/**
 * Production-faithful join probe: does the OVERLAP join (sample the log
 * offset, then capture, then stream from the sample) leave a viewer of a
 * busy-redrawing pane with a drifted cursor?
 *
 *   bunx turbo build --filter=@internal/server
 *   cd apps/server/web
 *   bun --preload ./scripts/probe-preload.ts scripts/probe-join.ts <subshell-id> [runs]
 *
 * probe-stream waits for the pane to go quiet before joining, which is the
 * 2026-09-04 rolled-back strategy; production joins mid-redraw. For a TUI
 * that repaints with relative moves (claude-code's Ink), the overlap re-
 * applies frames the capture already painted, and if that drifts the client
 * cursor the pinned region lands on the wrong rows — the reported garble.
 * This probe joins the way production does, streams like production does
 * (streaming decoder + sync stripper), and diffs the client buffer against
 * the pane at the next still moment.
 */
import { createHash } from "node:crypto";
import { Terminal } from "@xterm/xterm";
import { captureToReplayText } from "../../api/dist/api/ws/capture-text.js";
import { SyncStreamStripper } from "../../api/dist/api/ws/sync-stripper.js";

const id = process.argv[2];
if (!id) throw new Error("usage: probe-join.ts <subshell-id> [runs]");
const runs = Number(process.argv[3] ?? 6);
const socket = `subshell-${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
const logPath = `${process.env.HOME}/.config/subshell-server/subshells/${id}.log`;

const tmux = (args: string[]): string => {
  const p = Bun.spawnSync(["tmux", "-L", socket, ...args]);
  if (p.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};
const paneGeo = () => {
  const [c, r] = tmux(["display-message", "-t", id, "-p", "#{pane_width}:#{pane_height}"]).trim().split(":");
  return { cols: Number(c), rows: Number(r) };
};
/** Reads EXACTLY like the agent's paneCursor, empty-field bug included. */
const paneCursor = () => {
  const out = tmux(["display-message", "-t", id, "-p", "#{cursor_x}:#{cursor_y}"]).trim();
  const [rawX, rawY] = out.split(":");
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return null;
  return { x, y };
};
const logSize = () => Bun.file(logPath).size ?? 0;
const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));
const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: probing raw terminal bytes
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

async function oneJoin(geo: { cols: number; rows: number }): Promise<{ ok: boolean; note: string }> {
  const term = new Terminal({ cols: geo.cols, rows: geo.rows, allowProposedApi: true, scrollback: 1000 });
  // The production order: sample offset, capture mid-redraw (NO quiet wait),
  // read the cursor right after the capture, ship replay, then stream from
  // the sample (the overlap), then keep streaming live bytes.
  const logStart = logSize();
  const text = tmux(["capture-pane", "-p", "-e", "-J", "-t", id, "-S", "-100"]);
  const cursor = paneCursor();
  const replay = captureToReplayText(text, cursor ?? undefined);
  term.write(replay);
  await flush(term);
  const decoder = new TextDecoder();
  const stripper = new SyncStreamStripper();
  let last = logStart;
  const until = Date.now() + 4000; // stream like the tail does (50 ms polls)
  while (Date.now() < until) {
    const size = logSize();
    if (size > last) {
      const buf = await Bun.file(logPath).slice(last, size).bytes();
      last = size;
      const chunk = stripper.push(decoder.decode(buf, { stream: true }));
      if (chunk) {
        term.write(chunk);
        await flush(term);
      }
    }
    await Bun.sleep(50);
  }
  // Compare at a still moment.
  for (let i = 0; i < 200; i++) {
    const before = logSize();
    Bun.sleepSync(30);
    if (logSize() === before) break;
  }
  const tail = logSize();
  if (tail > last) {
    const buf = await Bun.file(logPath).slice(last, tail).bytes();
    const chunk = stripper.push(decoder.decode(buf, { stream: true }));
    if (chunk) {
      term.write(chunk);
      await flush(term);
    }
  }
  const afterText = tmux(["capture-pane", "-p", "-e", "-J", "-t", id, "-S", "-100"]);
  const paneGrid = stripAnsi(afterText)
    .replace(/\n$/, "")
    .split("\n")
    .slice(-geo.rows)
    .map((l) => l.replace(/\s+$/, ""));
  const buf = term.buffer.active;
  const clientGrid = Array.from({ length: term.rows }, (_, i) =>
    (buf.getLine(buf.baseY + i)?.translateToString(true) ?? "").replace(/\s+$/, ""),
  );
  for (let i = 0; i < Math.min(paneGrid.length, clientGrid.length); i++) {
    if (paneGrid[i] !== clientGrid[i]) {
      const sample = `row ${i}: pane ${JSON.stringify(paneGrid[i]?.slice(0, 40))} vs client ${JSON.stringify(clientGrid[i]?.slice(0, 40))}`;
      return { ok: false, note: sample };
    }
  }
  const cur = paneCursor();
  const cursorNote = cur
    ? `cursor pane (${cur.x},${cur.y}) client (${buf.cursorX},${buf.cursorY})`
    : "cursor read: none";
  return { ok: buf.cursorY === (cur?.y ?? buf.cursorY), note: cursorNote };
}

const geo = paneGeo();
let diverged = 0;
for (let i = 0; i < runs; i++) {
  const { ok, note } = await oneJoin(geo);
  if (!ok) diverged++;
  console.log(`join ${i + 1}/${runs}: ${ok ? "ok" : "DIVERGED"} — ${note}`);
  await Bun.sleep(200);
}
console.log(`\n${diverged}/${runs} production-style joins diverged`);
