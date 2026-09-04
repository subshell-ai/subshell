/**
 * Reproduce the 2026-09-04 "leave the PWA and return, screen is jumbled" bug
 * offline, from a live pane's REAL content.
 *
 *   bunx turbo build
 *   cd apps/frontend
 *   bun --preload ./src/test-setup.ts scripts/probe-desync.ts <subshell-id>
 *
 * Hypothesis under test: the client resizes its OWN xterm (fit.fit() on any
 * ResizeObserver / visualViewport tick) while the tmux pane keeps its size, so
 * the app's next frame — positioned with relative vertical moves, which is all
 * Claude Code uses — is applied to a grid whose rows no longer line up.
 */
import { createHash } from "node:crypto";
import { Terminal } from "@xterm/xterm";
import { captureToReplayText } from "../../server/dist/ws/capture-text.js";

const id = process.argv[2];
if (!id) throw new Error("usage: probe-desync.ts <subshell-id>");
const socket = `subshell-${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;

const tmux = (args: string[]): string => {
  const p = Bun.spawnSync(["tmux", "-L", socket, ...args]);
  if (p.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

const geo = tmux(["display-message", "-t", id, "-p", "#{pane_width}:#{pane_height}"]).trim().split(":");
const cols = Number(geo[0]);
const rows = Number(geo[1]);
const cur = tmux(["display-message", "-t", id, "-p", "#{cursor_x}:#{cursor_y}"]).trim().split(":");
const cursor = { x: Number(cur[0]), y: Number(cur[1]) };
const capture = tmux(["capture-pane", "-p", "-e", "-t", id, "-S", "-100"]);
const plainGrid = tmux(["capture-pane", "-p", "-t", id]).replace(/\n$/, "").split("\n");

const flush = (t: Terminal) => new Promise<void>((r) => t.write("", () => r()));
const screen = (t: Terminal): string[] => {
  const b = t.buffer.active;
  return Array.from({ length: t.rows }, (_, i) =>
    (b.getLine(b.baseY + i)?.translateToString(true) ?? "").replace(/\s+$/, ""),
  );
};

const ESC = "\x1b";
/**
 * One Ink-style repaint of the whole UI, in the app's own idiom (measured from
 * the pane log): walk UP to the top of the render region, then rewrite each
 * row with an erase-to-end-of-line. `moveUp` is what the APP believes the
 * distance to its first row is — it computes that from the PANE's geometry.
 */
function inkFrame(lines: string[], moveUp: number): string {
  let out = `${ESC}[${moveUp}A`;
  lines.forEach((l, i) => {
    out += `${ESC}[G${ESC}[2K${l}`;
    if (i < lines.length - 1) out += "\r\n";
  });
  return out;
}

// The app's NEXT frame: the same list with the selection moved to option 1 —
// which is exactly what the reported screenshot shows on top of the old frame.
const nextLines = plainGrid.map((l) =>
  l.startsWith("❯ 6.") ? l.replace("❯ 6.", "  6.") : /^ {2}1\. /.test(l) ? l.replace("  1.", "❯ 1.") : l,
);
const frame = inkFrame(nextLines, rows - 1);
const replay = captureToReplayText(capture, cursor);

const signature = (rowsOut: string[]) => {
  const markers = rowsOut.filter((r) => r.includes("❯")).length;
  const remnant = rowsOut.find((r) => /Chat about this\S/.test(r));
  return { markers, remnant: remnant ?? null };
};

console.log(`pane ${cols}x${rows}, cursor (${cursor.x},${cursor.y})\n`);

// CONTROL: client grid matches the pane the whole way through.
{
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  t.reset();
  t.write(replay);
  await flush(t);
  t.write(frame);
  await flush(t);
  const s = signature(screen(t));
  console.log(`CONTROL (client stays ${cols}x${rows}):  markers=${s.markers}  remnant=${JSON.stringify(s.remnant)}`);
}

// HYPOTHESIS: the client resized itself between the replay and the frame.
for (const clientRows of [rows - 1, rows - 2, rows - 4, rows - 5, rows + 2]) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  t.reset();
  t.write(replay);
  await flush(t);
  t.resize(cols, clientRows); // fit.fit() on an iOS viewport tick; the pane is untouched
  await flush(t);
  t.write(frame); // bytes still positioned for the PANE's geometry
  await flush(t);
  const out = screen(t);
  const s = signature(out);
  console.log(
    `client resized to ${cols}x${clientRows}:      markers=${s.markers}  remnant=${JSON.stringify(s.remnant)}`,
  );
  if (s.markers > 1 || s.remnant) {
    console.log("   ^^ REPRODUCED the reported signature; screen:");
    out.forEach((r, i) => {
      console.log(`      ${String(i).padStart(2)} ${r}`);
    });
  }
}
