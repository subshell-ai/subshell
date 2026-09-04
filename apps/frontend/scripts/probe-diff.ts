/**
 * The apples-to-apples differential for the attach path.
 *
 *   bunx turbo build
 *   cd apps/frontend
 *   bun --preload ./src/test-setup.ts scripts/probe-diff.ts <subshell-id> [keys]
 *
 * Takes a quiet join off a LIVE pane, drives it with real keystrokes, then
 * feeds the identical `replay + streamed bytes` to
 *   A) xterm (what the browser does), and
 *   B) a throwaway tmux pane of the same size (what the server's pane does),
 * and diffs both against the live pane.
 *
 * B == live proves the (replay, frames) pair is sufficient to reconstruct the
 * pane. A != B then localizes the defect to how those bytes land in xterm
 * versus tmux — which is the difference the attach replay has to neutralize.
 */
import { createHash } from "node:crypto";
import { Terminal } from "@xterm/xterm";
import { captureToReplayText } from "../../server/dist/ws/capture-text.js";

const id = process.argv[2];
if (!id) throw new Error("usage: probe-diff.ts <subshell-id> [keys]");
const keyCount = Number(process.argv[3] ?? 6);
const socket = `subshell-${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
const logPath = `${process.env.HOME}/.config/subshell-server/subshells/${id}.log`;

const tmux = (args: string[], sock = socket): string => {
  const p = Bun.spawnSync(["tmux", "-L", sock, ...args]);
  if (p.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};
const logSize = (): number => {
  try {
    return Bun.spawnSync(["stat", "-c", "%s", logPath]).stdout.toString().trim()
      ? Number(Bun.spawnSync(["stat", "-c", "%s", logPath]).stdout.toString().trim())
      : 0;
  } catch {
    return 0;
  }
};
const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: probing raw terminal bytes
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const trim = (rows: string[]): string[] => rows.map((r) => r.replace(/\s+$/, ""));

/** Quiet join: grid + cursor + log offset from one provably still moment. */
function quietJoin(cap = 100) {
  for (let i = 0; i < 300; i++) {
    const before = logSize();
    const text = tmux(["capture-pane", "-p", "-e", "-t", id, "-S", `-${cap}`]);
    const [cx, cy] = tmux(["display-message", "-t", id, "-p", "#{cursor_x}:#{cursor_y}"]).trim().split(":");
    if (logSize() === before) return { text, cursor: { x: Number(cx), y: Number(cy) }, joinAt: before };
    Bun.sleepSync(30);
  }
  throw new Error("pane never went quiet");
}

const [gw, gh] = tmux(["display-message", "-t", id, "-p", "#{pane_width}:#{pane_height}"]).trim().split(":");
const cols = Number(gw);
const rows = Number(gh);
const join = quietJoin();
const replay = captureToReplayText(join.text, join.cursor);
console.log(`pane ${cols}x${rows}, joined at ${join.joinAt}, cursor (${join.cursor.x},${join.cursor.y})`);

// Drive the live pane with real keystrokes, then collect exactly what streamed.
for (let i = 0; i < keyCount; i++) {
  tmux(["send-keys", "-t", id, i % 2 === 0 ? "Up" : "Down"]);
  await Bun.sleep(1200);
}
await Bun.sleep(1500);
const end = logSize();
const frames = await Bun.file(logPath).slice(join.joinAt, end).bytes();
const stream = replay + new TextDecoder().decode(frames);
await Bun.write("/tmp/subshell-repro/stream.bin", stream);
console.log(`streamed ${frames.byteLength} bytes of real frames\n`);

// A) xterm — what the browser does with those bytes.
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
term.reset();
term.write(stream);
await new Promise<void>((r) => term.write("", () => r()));
const xb = term.buffer.active;
const xtermGrid = trim(Array.from({ length: rows }, (_, i) => xb.getLine(xb.baseY + i)?.translateToString(true) ?? ""));

// B) a throwaway tmux pane of the same size, fed the identical bytes.
const sock2 = `probe-diff-${process.pid}`;
tmux(
  [
    "new-session",
    "-d",
    "-s",
    "t",
    "-x",
    String(cols),
    "-y",
    String(rows),
    "cat /tmp/subshell-repro/stream.bin; sleep 300",
  ],
  sock2,
);
await Bun.sleep(2500);
const tmuxGrid = trim(
  stripAnsi(tmux(["capture-pane", "-p", "-t", "t"], sock2))
    .replace(/\n$/, "")
    .split("\n"),
);
const tmuxCursor = tmux(["display-message", "-t", "t", "-p", "#{cursor_x}:#{cursor_y}"], sock2).trim();
Bun.spawnSync(["tmux", "-L", sock2, "kill-server"]);

// C) the live pane — ground truth.
const after = quietJoin(0);
const liveGrid = trim(stripAnsi(after.text).replace(/\n$/, "").split("\n").slice(-rows));

const firstDiff = (a: string[], b: string[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? "") !== (b[i] ?? "")) return i;
  return -1;
};
console.log(
  `cursor  xterm=(${xb.cursorX},${xb.cursorY})  tmux=(${tmuxCursor})  live=(${after.cursor.x},${after.cursor.y})`,
);
console.log(
  `tmux-replay vs LIVE : ${firstDiff(tmuxGrid, liveGrid) === -1 ? "MATCH" : `diverge at row ${firstDiff(tmuxGrid, liveGrid)}`}`,
);
console.log(
  `xterm       vs LIVE : ${firstDiff(xtermGrid, liveGrid) === -1 ? "MATCH" : `diverge at row ${firstDiff(xtermGrid, liveGrid)}`}`,
);
console.log(
  `xterm       vs tmux : ${firstDiff(xtermGrid, tmuxGrid) === -1 ? "MATCH" : `diverge at row ${firstDiff(xtermGrid, tmuxGrid)}`}`,
);
const d = firstDiff(xtermGrid, tmuxGrid);
if (d !== -1) {
  for (let i = Math.max(0, d - 1); i < Math.min(rows, d + 5); i++) {
    console.log(`  ${String(i).padStart(2)} tmux : ${JSON.stringify(tmuxGrid[i])}`);
    console.log(`     xterm: ${JSON.stringify(xtermGrid[i])}`);
  }
}
