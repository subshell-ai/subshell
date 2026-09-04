/**
 * Step a captured frame stream through xterm AND a real tmux pane one escape
 * sequence at a time, and report the FIRST token where their cursors part.
 *
 *   cd apps/frontend
 *   bun --preload ./src/test-setup.ts scripts/probe-clamp.ts [startRow]
 *
 * Reads /tmp/subshell-repro/frames.bin (saved by probe-stream/probe-diff).
 * The screen is seeded with numbered rows and the cursor parked on
 * `startRow`, because the 2026-09-04 divergence only appears from certain
 * cursor rows: identical bytes from the bottom row kept the two byte-identical,
 * while mid-screen they diverged and every later frame landed ~8 rows high.
 *
 * tmux is driven through a FIFO so one pane can be fed incrementally and its
 * cursor read after every token — a per-token trace instead of a per-run diff.
 */
import { openSync, writeSync } from "node:fs";
import { Terminal } from "@xterm/xterm";

const COLS = 89;
const ROWS = 27;
const startRow = Number(process.argv[2] ?? 12);
const sock = `probe-clamp-${process.pid}`;
const fifo = `/tmp/subshell-repro/clamp.fifo`;

const tmux = (args: string[]): string => {
  const p = Bun.spawnSync(["tmux", "-L", sock, ...args]);
  if (p.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};
const paneCursor = (): string => tmux(["display-message", "-t", "t", "-p", "#{cursor_x},#{cursor_y}"]).trim();

/** Split into single escape sequences, control bytes, and printable runs. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: tokenizing raw terminal bytes
  const re = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[78]|[\r\n\x0e\x0f\x07\x08]|[^\x1b\r\n\x0e\x0f\x07\x08]+/g;
  for (const m of s.matchAll(re)) out.push(m[0]);
  return out;
}
const pretty = (t: string): string =>
  t.replace(/\x1b/g, "ESC").replace(/\r/g, "<CR>").replace(/\n/g, "<LF>").replace(/\x0f/g, "<SI>").replace(/\x0e/g, "<SO>");

const frames = new TextDecoder().decode(await Bun.file("/tmp/subshell-repro/frames.bin").bytes());
// Seed: numbered rows so any shift is legible, then park the cursor.
const seed = `\x1b[H${Array.from({ length: ROWS }, (_, i) => `R${String(i).padStart(2, "0")}`).join("\r\n")}\x1b[${startRow + 1};1H`;

// --- tmux side: one pane, fed incrementally through a FIFO.
Bun.spawnSync(["rm", "-f", fifo]);
Bun.spawnSync(["mkfifo", fifo]);
tmux(["new-session", "-d", "-s", "t", "-x", String(COLS), "-y", String(ROWS), `cat ${fifo}`]);
await Bun.sleep(600);
const fd = openSync(fifo, "a");
const feedTmux = async (s: string) => {
  writeSync(fd, s);
  await Bun.sleep(28); // let tmux apply it before the cursor is read
};

// --- xterm side.
const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 });
const flush = () => new Promise<void>((r) => term.write("", () => r()));
const xtermCursor = () => `${term.buffer.active.cursorX},${term.buffer.active.cursorY}`;

term.reset();
term.write(seed);
await flush();
await feedTmux(seed);
console.log(`seeded ${COLS}x${ROWS}, cursor parked on row ${startRow}`);
console.log(`  tmux=${paneCursor()}  xterm=${xtermCursor()}\n`);

const tokens = tokenize(frames);
console.log(`stepping ${tokens.length} tokens…\n`);
let diverged = false;
for (let i = 0; i < tokens.length; i++) {
  const t = tokens[i] ?? "";
  term.write(t);
  await flush();
  await feedTmux(t);
  const x = xtermCursor();
  const m = paneCursor();
  if (x !== m) {
    console.log(`FIRST DIVERGENCE at token ${i}: ${JSON.stringify(pretty(t))}`);
    console.log(`  tmux cursor  = ${m}`);
    console.log(`  xterm cursor = ${x}`);
    console.log(`  preceding tokens: ${tokens.slice(Math.max(0, i - 6), i).map(pretty).map((s) => JSON.stringify(s)).join(" ")}`);
    diverged = true;
    break;
  }
}
if (!diverged) console.log("no cursor divergence across the whole stream");
Bun.spawnSync(["tmux", "-L", sock, "kill-server"]);
Bun.spawnSync(["rm", "-f", fifo]);
