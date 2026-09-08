/**
 * End-to-end fidelity probe for the LIVE attach path, offline.
 *
 *   bunx turbo build
 *   cd apps/server/web
 *   bun --preload ./src/test-setup.ts scripts/probe-stream.ts <subshell-id> [seconds]
 *
 * Does exactly what a browser does — quiet-join replay, then apply the pane
 * log's appended bytes as they arrive — and then asks the only question that
 * matters: does the resulting xterm screen still equal tmux's own grid?
 *
 * A divergence here IS the reported garble, caught in a harness where it can
 * be replayed and bisected. Read-only: it never writes to the pane.
 */
import { createHash } from "node:crypto";
import { Terminal } from "@xterm/xterm";
import { captureToReplayText } from "../../server/dist/ws/capture-text.js";

const id = process.argv[2];
if (!id) throw new Error("usage: probe-stream.ts <subshell-id> [seconds]");
const seconds = Number(process.argv[3] ?? 20);
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
const paneCursor = () => {
  const [x, y] = tmux(["display-message", "-t", id, "-p", "#{cursor_x}:#{cursor_y}"]).trim().split(":");
  return { x: Number(x), y: Number(y) };
};
const logSize = () => Bun.file(logPath).size ?? 0;
const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));

/** The server's quiet join: grid + cursor + log offset from one still moment. */
function quietJoin() {
  for (let i = 0; i < 200; i++) {
    const before = logSize();
    const text = tmux(["capture-pane", "-p", "-e", "-t", id, "-S", "-100"]);
    const cursor = paneCursor();
    if (logSize() === before) return { text, cursor, joinAt: before };
    Bun.sleepSync(30);
  }
  throw new Error("pane never went quiet");
}

const geo = paneGeo();
const join = quietJoin();
const term = new Terminal({ cols: geo.cols, rows: geo.rows, allowProposedApi: true, scrollback: 1000 });
term.reset();
term.write(captureToReplayText(join.text, join.cursor));
await flush(term);
console.log(`joined ${geo.cols}x${geo.rows} at byte ${join.joinAt}, cursor (${join.cursor.x},${join.cursor.y})`);

// Stream the log exactly like the tail does: chunked reads, streaming decode.
const decoder = new TextDecoder();
let cursorByte = join.joinAt;
let bytes = 0;
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  const size = logSize();
  if (size > cursorByte) {
    const buf = await Bun.file(logPath).slice(cursorByte, size).bytes();
    cursorByte = size;
    bytes += buf.byteLength;
    term.write(decoder.decode(buf, { stream: true }));
    await flush(term);
  }
  await Bun.sleep(120);
}
await flush(term);
console.log(`streamed ${bytes} bytes`);

// Compare against the pane, at a still moment so neither side is mid-frame.
const after = quietJoin();
if (after.joinAt !== cursorByte) {
  const tailBuf = await Bun.file(logPath).slice(cursorByte, after.joinAt).bytes();
  term.write(decoder.decode(tailBuf, { stream: true }));
  await flush(term);
  console.log(`caught up ${tailBuf.byteLength} trailing bytes`);
}
const geo2 = paneGeo();
if (geo2.cols !== geo.cols || geo2.rows !== geo.rows) {
  console.log(
    `NOTE: pane resized mid-run (${geo.cols}x${geo.rows} -> ${geo2.cols}x${geo2.rows}); result is not comparable`,
  );
}

const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: probing raw terminal bytes
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const paneGrid = stripAnsi(after.text)
  .replace(/\n$/, "")
  .split("\n")
  .slice(-geo2.rows)
  .map((l) => l.replace(/\s+$/, ""));
const buf = term.buffer.active;
const clientGrid = Array.from({ length: term.rows }, (_, i) =>
  (buf.getLine(buf.baseY + i)?.translateToString(true) ?? "").replace(/\s+$/, ""),
);
const cur2 = after.cursor;

let bad = -1;
for (let i = 0; i < Math.min(paneGrid.length, clientGrid.length); i++) {
  if (paneGrid[i] !== clientGrid[i]) {
    bad = i;
    break;
  }
}
console.log(`\ncursor: pane (${cur2.x},${cur2.y})  client (${buf.cursorX},${buf.cursorY})`);
console.log(bad === -1 ? "GRIDS MATCH — the streaming path is faithful" : `GRIDS DIVERGE, first at row ${bad}`);
if (bad !== -1) {
  for (let i = Math.max(0, bad - 1); i < Math.min(paneGrid.length, bad + 6); i++) {
    console.log(`  ${String(i).padStart(2)} pane  : ${JSON.stringify(paneGrid[i])}`);
    console.log(`     client: ${JSON.stringify(clientGrid[i])}`);
  }
}
