/**
 * Attach-alignment probe: feed the REAL deployed replay bytes for a REAL live
 * pane into a REAL xterm, then compare the resulting buffer against tmux's own
 * grid. Answers "does the client end up showing what the pane shows, with the
 * cursor where the pane says" — the invariant every relative-positioned TUI
 * frame depends on, and the one whose breakage caused the 2026-09-04 garble.
 *
 * The happy-dom preload is required (xterm needs DOM globals), and it reads
 * `apps/server/dist`, so build first:
 *
 *   bunx turbo build
 *   cd apps/frontend
 *   bun --preload ./src/test-setup.ts scripts/probe-replay.ts <subshell-id> [capLines]
 *
 * Read-only: it runs `capture-pane` / `display-message` and never writes to
 * the pane. `apps/frontend/src/lib/__tests__/replay-alignment.test.ts` pins
 * the same invariant on synthetic input; this checks a live pane's real
 * content (emoji, box drawing, SGR), which is where width disagreements
 * between tmux and xterm would show up.
 */
import { createHash } from "node:crypto";
import { Terminal } from "@xterm/xterm";
import { captureToReplayText } from "../../server/dist/ws/capture-text.js";

const id = process.argv[2];
if (!id) throw new Error("usage: bun probe-replay.ts <subshell-id> [capLines]");
const cap = Number(process.argv[3] ?? 100);
const socket = `subshell-${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;

const tmux = (args: string[]): string => {
  const p = Bun.spawnSync(["tmux", "-L", socket, ...args]);
  if (p.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: probing raw terminal bytes
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** The server's quiet join: capture + cursor sampled across a still moment. */
function quietSnapshot(): { text: string; cursor: { x: number; y: number }; cols: number; rows: number } {
  for (let i = 0; i < 60; i++) {
    const geo = tmux(["display-message", "-t", id, "-p", "#{pane_width}:#{pane_height}"]).trim().split(":");
    const before = tmux(["capture-pane", "-p", "-e", "-t", id, "-S", `-${cap}`]);
    const cur = tmux(["display-message", "-t", id, "-p", "#{cursor_x}:#{cursor_y}"]).trim().split(":");
    const after = tmux(["capture-pane", "-p", "-e", "-t", id, "-S", `-${cap}`]);
    if (before === after) {
      return {
        text: before,
        cursor: { x: Number(cur[0]), y: Number(cur[1]) },
        cols: Number(geo[0]),
        rows: Number(geo[1]),
      };
    }
    Bun.sleepSync(50);
  }
  throw new Error("pane never went quiet");
}

const snap = quietSnapshot();
const replay = captureToReplayText(snap.text, snap.cursor);

const term = new Terminal({ cols: snap.cols, rows: snap.rows, allowProposedApi: true, scrollback: 1000 });
term.reset();
term.write(replay);
await new Promise<void>((r) => term.write("", () => r()));

const buf = term.buffer.active;
// tmux gave one output line per physical row; the LAST `rows` of them are the
// visible grid, which is what the client's viewport must show.
const capturedLines = snap.text.replace(/\n$/, "").split("\n");
const gridLines = capturedLines.slice(-snap.rows).map((l) => stripAnsi(l).replace(/\s+$/, ""));

console.log(
  `pane ${snap.cols}x${snap.rows}  captured lines=${capturedLines.length}  cursor=(${snap.cursor.x},${snap.cursor.y})`,
);
console.log(`xterm buffer length=${buf.length}  baseY=${buf.baseY}  cursor=(${buf.cursorX},${buf.cursorY})`);
console.log(`expected: buffer length=${capturedLines.length}  baseY=${capturedLines.length - snap.rows}`);

let rowMismatch = -1;
for (let i = 0; i < snap.rows; i++) {
  const got = (buf.getLine(buf.baseY + i)?.translateToString(true) ?? "").replace(/\s+$/, "");
  if (got !== gridLines[i]) {
    rowMismatch = i;
    console.log(`\nFIRST ROW MISMATCH at viewport row ${i}:`);
    console.log(`  tmux : ${JSON.stringify(gridLines[i])}`);
    console.log(`  xterm: ${JSON.stringify(got)}`);
    break;
  }
}
const cursorOk = buf.cursorX === snap.cursor.x && buf.cursorY === snap.cursor.y;
console.log(`\nrows match: ${rowMismatch === -1}   cursor matches: ${cursorOk}`);
if (!cursorOk) {
  console.log(`  cursor drift: rows ${buf.cursorY - snap.cursor.y}, cols ${buf.cursorX - snap.cursor.x}`);
}
// Wrapping is the prime suspect when the row count grew: find which captured
// row xterm needed more than one buffer line for.
if (buf.length !== capturedLines.length) {
  console.log(`\nBUFFER GREW by ${buf.length - capturedLines.length} line(s) -> some captured row WRAPPED.`);
  for (let i = 0; i < Math.min(capturedLines.length, 400); i++) {
    const plain = stripAnsi(capturedLines[i] ?? "");
    if ([...plain].length > snap.cols) {
      console.log(
        `  captured row ${i} is ${[...plain].length} chars > ${snap.cols} cols: ${JSON.stringify(plain.slice(0, 80))}`,
      );
    }
  }
}
