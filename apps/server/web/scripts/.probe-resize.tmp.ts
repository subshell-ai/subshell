/**
 * Does a client-side xterm resize while the pane keeps its size (and keeps
 * painting relative frames) leave the pinned region on the wrong rows?
 * Mirrors what a desktop window drag does through the dock's fit loop when
 * the pane never gets the resize (or gets it later).
 */
import { Terminal } from "@xterm/xterm";

const term = new Terminal({ cols: 72, rows: 24, allowProposedApi: true, scrollback: 100 });
const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));
// Simulate a Claude-Code-like layout: 20 rows of transcript, then a pinned
// block (spinner + separators + prompt box) the app repaints with cursor-up.
let out = "";
for (let i = 1; i <= 18; i++) out += `transcript line ${i}\r\n`;
out += "\r\n"; // blank
out += "✻ Spellunking… (0s)\r\n────────────────────\r\n❯ \r\n────────────────────\r\n";
term.write(out);
await flush(term);
// The app's next repaint: from the bottom of its frame, move UP to the
// spinner row (5 rows up) and rewrite it — pure relative moves, exactly
// what Ink emits (the pinned block spans rows 21-24 of a 24-row grid).
const repaint = "\x1b[5A\x1b[0J✻ Spellunking… (1s · ↓ 9 tokens)\r\n";
const beforeY = term.buffer.active.cursorY;
term.resize(72, 22); // client shrinks on its own (window drag; pane NOT yet resized)
term.write(repaint);
await flush(term);
const buf = term.buffer.active;
const grid = Array.from({ length: term.rows }, (_, i) => buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
const spinnerRow = grid.findIndex((l) => l.includes("Spellunking"));
console.log(`cursor before resize row ${beforeY}, after row ${buf.cursorY}`);
console.log(`spinner found at grid row ${spinnerRow} of ${term.rows} (expected ${term.rows - 4})`);
console.log(JSON.stringify(grid.slice(16, 22), null, 0));
term.dispose();
