/**
 * The Logs section: one region, two tabs.
 *
 * The server's log is what the pane shows by default, because it is true all
 * the time; a command's output takes over when there is one — but only when
 * the person ASKS for it now, through the result strip's "Show output". Before
 * the sidebar, a command's output stole the tab on its own, which was right
 * when the pane sat directly under the buttons. It is a section away now, so
 * stealing a tab nobody is looking at would only mean finding the wrong one
 * selected on a later visit.
 */
import type { ActionResult } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { el } from "./state";

/** Which pane is in front. The log unless someone asked for the output. */
let pane: "log" | "output" = "log";

/** Where the log came from, captioned beside the tabs. */
let logSource = "";

/** Bring one pane forward. */
export function showPane(next: "log" | "output"): void {
  pane = next;
  for (const id of ["log", "output"]) {
    el(id).hidden = id !== pane;
    el(`tab-${id}`).setAttribute("aria-selected", String(id === pane));
  }
  el("pane-source").textContent = pane === "log" ? logSource : "";
}

/**
 * Offer the command-output tab only once a command has said something.
 *
 * The log is true all the time; a command's output is not, and until one has
 * run there is nothing behind that tab. `.pane-pre:empty` already collapses
 * the box, so the tab led to a bordered void with no explanation of what it
 * was for. A tab that can only disappoint is worse than no tab: the region
 * is two tabs when there are two things to read, and one otherwise.
 */
export function syncPaneTabs(): void {
  el("tab-output").hidden = !hasOutput();
  // Never strand the selection on a tab that just went away.
  if (!hasOutput() && pane === "output") showPane("log");
}

/** Whether the command-output pane holds anything — what "Show output" promises. */
export function hasOutput(): boolean {
  return el("output").textContent !== "";
}

/**
 * Show a result's own words. `ok:false` is styled as a failure, not as output.
 *
 * Returns whether the command said anything, which is what the result strip
 * needs to decide if "Show output" leads anywhere.
 */
export function show(result: ActionResult | null): boolean {
  const parts: string[] = [];
  if (result?.stdout?.trim()) parts.push(result.stdout.trim());
  if (result?.stderr?.trim()) parts.push(result.stderr.trim());
  const out = el("output");
  out.textContent = parts.join("\n\n");
  out.classList.toggle("output-bad", result?.ok === false);
  syncPaneTabs();
  return parts.length > 0;
}

/** Bring the command output forward — the result strip's "Show output". */
export function revealOutput(): void {
  showPane("output");
}

/**
 * Pull the log tail and render it.
 *
 * Rides the same tick as the probe (see the page's poll), so the pane follows
 * the server without a mechanism of its own, and regardless of which section
 * is on screen — a Logs section that started tailing only when opened would
 * show a stale pane for its first second every time. Two behaviours worth
 * keeping:
 *
 * - It STICKS to the bottom only when it is already there. Re-tailing while
 *   someone has scrolled up to read would yank the view out from under them.
 * - A note (no entries yet, no service installed) is rendered as the pane's
 *   text rather than as an error, because during setup it is the ordinary
 *   answer and an error banner would teach the user to ignore the pane.
 */
export async function refreshLog(): Promise<void> {
  const tail = await ipc.logs();
  const box = el("log");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.textContent = tail.text || tail.note || "";
  box.classList.toggle("muted-text", !tail.text);
  logSource = tail.text || tail.note ? tail.source : "";
  if (pane === "log") el("pane-source").textContent = logSource;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** Wire the two tabs. Called once, at boot. */
export function wirePaneTabs(): void {
  for (const id of ["log", "output"] as const) {
    el(`tab-${id}`).addEventListener("click", () => showPane(id));
  }
}
