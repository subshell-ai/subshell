/**
 * The server's log, and the last action's own words, rendered into whatever
 * box the screen gives them.
 *
 * This was the console's Logs SECTION — one region with two tabs, a caption
 * and a selection that had to survive navigation. None of that survives the
 * console: the assistant has one screen at a time, and both of these live
 * inside the recovery screen's Show Details disclosure, one under the other.
 * A tab strip over two panes inside a disclosure inside a 560px column is
 * chrome for its own sake.
 *
 * What DID survive is the behaviour that was load-bearing: the tail sticks to
 * the bottom only when it is already there, and a note (no entries yet, no
 * service installed) renders as the pane's own muted text rather than as an
 * error, because during setup it is the ordinary answer and an error banner
 * would teach the reader to ignore the pane.
 */
import type { ActionResult, LogTail } from "../lib/ipc";

/**
 * Render a tail into `box`, keeping the view where the reader put it.
 *
 * Re-tailing while someone has scrolled up to read would yank the view out
 * from under them, and this runs on the page's poll while the disclosure is
 * open — so the check is not a nicety.
 */
export function renderTail(box: HTMLElement, tail: LogTail | null): void {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.textContent = tail === null ? "" : tail.text || tail.note || "";
  box.classList.toggle("muted-text", !tail?.text);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/**
 * Render a result's own words. `ok: false` is styled as a failure, not as
 * output — two surfaces that phrase one outcome differently are two surfaces
 * that drift, and this is the same `output-bad` treatment the reset screen's
 * half-run log gets.
 *
 * Returns whether the command said anything, so a caller can leave the box
 * out entirely rather than showing a bordered void.
 */
export function renderOutput(box: HTMLElement, result: ActionResult | null): boolean {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  box.textContent = parts.join("\n\n");
  box.classList.toggle("output-bad", result?.ok === false);
  return parts.length > 0;
}
