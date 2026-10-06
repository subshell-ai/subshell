import { appendFile, stat } from "node:fs/promises";

import type { TmuxRunner } from "./tmux-runner.js";

/** How far back the seed reaches: tmux clamps `-S` to the pane's history. */
const SEED_SCROLLBACK_LINES = 100_000;

/**
 * Backfill a pane's replay log with what it printed BEFORE the pipe-pane
 * child could attach. pipe-pane streams only the post-attach tail, so a pane
 * whose program emits in its first microseconds (any script that echoes a
 * banner, then settles into silence) leaves those bytes in tmux's history and
 * never in the log: measured in the CI container, where the harness e2e cell
 * lost the fake binary's startup marker while local timing always won the
 * race. The rule is deliberately conservative: seed ONLY while the file has
 * received nothing - the capture child flushes every read, so a non-empty
 * file IS the stream already flowing, and prepending a screen reconstruction
 * would duplicate what arrived. It never throws: a pane with an imperfect
 * replay beats a refused launch, and this sits inside the best-effort attach
 * wrapper on both launchers (the agent's daemon executor and the plane's
 * local twin - the race has no machine class, so neither attaches without
 * it).
 *
 * @returns `null` when nothing was written, else a one-line description for
 * the caller's log (seeded, or the best-effort failure).
 */
export async function seedLogFromHistory(
  tmux: TmuxRunner,
  socket: string,
  subshellName: string,
  logFile: string,
): Promise<string | null> {
  try {
    const history = await tmux.capturePane(socket, subshellName, SEED_SCROLLBACK_LINES);
    if (history.trim() === "") return null;
    const existing = await stat(logFile).catch(() => null);
    if (existing !== null && existing.size > 0) return null;
    await appendFile(logFile, history.endsWith("\n") ? history : `${history}\n`, { mode: 0o600 });
    return `seeded the replay log from pane history (${history.length} chars)`;
  } catch (err) {
    return `log seed failed (best-effort, the pipe carries the tail): ${err instanceof Error ? err.message : String(err)}`;
  }
}
