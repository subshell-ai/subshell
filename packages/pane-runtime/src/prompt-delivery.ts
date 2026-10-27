import { stripAnsi } from "@internal/backend-errors";

/**
 * Automated prompt delivery for create/restart and REST input. Local and
 * remote launches share the startup settle rule, and REST input uses the same
 * render gate and paste-settle interval.
 *
 * The shape this code has to survive is measured, not hypothetical: Claude
 * Code paints its full UI within half a second of spawn but mounts its stdin
 * reader seconds later (MCP servers, hooks, plugins). Anything typed in that
 * window piles up in the pty, and the mount-time read consumes it as ONE
 * chunk, which the harness eats as a paste — the prompt's text lands in the
 * input box, but the trailing Enter is stripped and nothing submits. Waiting
 * for the screen to be non-blank cannot catch this: the screen is fully
 * painted while the pane still swallows input. What DOES prove the harness is
 * reading is the typed text coming back on the screen, so this waits for
 * exactly that between the type and the Enter — counted, not merely present,
 * because a short prompt hides inside ordinary banner text and a resumed pane
 * may already show the old transcript.
 */

/** The pane operations delivery needs; `TmuxRunner` is the production filler. */
export interface PromptDeliveryPane {
  capturePane(socket: string, subshellName: string, scrollbackLines?: number): Promise<string>;
  sendInput(socket: string, subshellName: string, input: string): Promise<void>;
  pressEnter(socket: string, subshellName: string): Promise<void>;
}

/** Timing knobs, all on the caller's clock: the server owns the one policy
 * and sends its settle budget to a node over the `prompt_deliver` wire; the
 * gate budget is the shared default unless the caller names one. */
export interface PromptDeliveryOptions {
  /** Budget for the settle wait: the pane showing its first output. */
  settleTimeoutMs: number;
  /** Budget for the render gate ALONE, counted from when the text lands.
   * Both delivery sites run without one, so they share `RENDER_GATE_TIMEOUT_MS`. */
  renderTimeoutMs?: number;
  /** Poll interval for both capture loops. */
  pollMs: number;
  /** Clock seam; tests own time, production reads `Date.now`. */
  nowMs?: () => number;
}

/**
 * How much of the end of the normalized prompt must appear before Enter goes.
 * A long prompt can scroll its beginning out of the composer, and seeing only
 * its beginning would let Enter overtake the remaining input. Normalization
 * joins wrapped rows so a narrow pane can still match the tail.
 */
const RENDER_NEEDLE_MAX_CHARS = 48;

/**
 * The gate's budget when the caller names none. Kept inside the shared module
 * rather than split across the two callers, so a node running under an older
 * server (the wire frame carries no gate field) and the control plane share
 * one gate budget.
 */
const RENDER_GATE_TIMEOUT_MS = 10_000;

// Serialize automated submissions through Enter. The low-level input chain
// orders individual writes, but a second prompt must not be typed while the
// first is still waiting for its render. Raw interactive input stays separate.
const submissions = new Map<string, Promise<void>>();

/** Whitespace runs carry no meaning for the render check: the pane wraps, and
 * Claude Code eats raw LFs out of a burst. Both sides normalize identically. */
function normalizeScreen(text: string): string {
  return stripAnsi(text).replace(/\s+/g, "");
}

/** Counts overlapping matches too: repeated runs can contain the final suffix
 * before its actual end. An empty needle has no useful render evidence. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

/**
 * Types `text` into a freshly-spawned pane once it shows output, then submits
 * with Enter — holding the Enter until the pane proves it rendered the typed
 * text, because an Enter that reaches a not-yet-mounted harness is swallowed
 * (see the file note). Returns whether the prompt was delivered: a pane that
 * never shows anything, or an input command that fails, reports `false`
 * rather than typing blind. A pane that never echoes the text (masked input,
 * a dialog that hides keystrokes) still gets its Enter when the gate budget
 * runs out — that is the pre-gate behavior, and better than no submit at all.
 *
 * The two waits keep separate budgets (settle, then the gate) so a slow boot
 * cannot starve the proof; a masked pane's worst-case delay is therefore
 * `settleTimeoutMs + renderTimeoutMs + 200ms`, still inside the remote RPC's
 * `settleTimeoutMs + 30s` slack.
 *
 * @param pane - the capture/send/enter trio (the `TmuxRunner`)
 * @param socket - the tmux socket the pane lives on
 * @param subshellId - the pane's tmux session name
 * @param text - the prompt to type; the caller trims it
 * @param opts - budgets, poll pacing, and the clock seam
 */
export async function deliverPromptInto(
  pane: PromptDeliveryPane,
  socket: string,
  subshellId: string,
  text: string,
  opts: PromptDeliveryOptions,
): Promise<boolean> {
  const now = opts.nowMs ?? Date.now;

  // Settle: a blank pane is still booting; swallow capture errors (the pane
  // is simply not queryable yet) and keep polling. ANSI control codes alone
  // are not output — a screen holding only a reset sequence is still blank.
  const settled = await waitFor(
    pane,
    socket,
    subshellId,
    now,
    now() + opts.settleTimeoutMs,
    opts.pollMs,
    (screen) => normalizeScreen(screen) !== "",
  );
  if (settled === undefined) return false;

  try {
    await submitPaneInput(pane, socket, subshellId, text, opts, settled);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends an automated input burst and submits it after the harness renders it.
 * Unlike create/restart delivery, this doesn't require a nonblank screen: an
 * already-running terminal may be waiting at an empty prompt. Input failures
 * propagate so REST callers retain their existing offline/error handling.
 *
 * `baseline` lets create/restart reuse its settled capture. Other callers take
 * a fresh capture before typing; a failed capture still permits raw input.
 * Submissions to the same pane wait through the previous Enter (or failure),
 * then take a fresh baseline so another prompt can't become part of this one.
 */
export function submitPaneInput(
  pane: PromptDeliveryPane,
  socket: string,
  subshellId: string,
  text: string,
  opts: Omit<PromptDeliveryOptions, "settleTimeoutMs">,
  baseline?: string,
): Promise<void> {
  const key = `${socket}\0${subshellId}`;
  const previous = submissions.get(key);
  const result = (previous ?? Promise.resolve()).then(() =>
    submitInput(pane, socket, subshellId, text, opts, previous ? undefined : baseline),
  );
  const settled = result.catch(() => {});
  submissions.set(key, settled);
  void settled.then(() => {
    if (submissions.get(key) === settled) submissions.delete(key);
  });
  return result;
}

/** Runs one queued submission; callers must hold this pane's submission slot. */
async function submitInput(
  pane: PromptDeliveryPane,
  socket: string,
  subshellId: string,
  text: string,
  opts: Omit<PromptDeliveryOptions, "settleTimeoutMs">,
  baseline?: string,
): Promise<void> {
  const now = opts.nowMs ?? Date.now;
  const before = baseline ?? (await pane.capturePane(socket, subshellId).catch(() => undefined));
  await pane.sendInput(socket, subshellId, text);

  // Count new occurrences so a banner or an earlier turn containing the same
  // text can't release Enter before the harness has read this input burst.
  const normalized = normalizeScreen(text);
  const needle = normalized.slice(-RENDER_NEEDLE_MAX_CHARS);
  if (needle !== "") {
    // Repeated suffixes can appear before the end of a long prompt. Require
    // every occurrence from this burst, not just the first one. If scrolling
    // hides earlier occurrences, use the bounded fallback instead of treating
    // a partial render as proof that the whole burst has arrived.
    // Without a baseline, existing screen text can't prove a new render.
    const expectedCount =
      before === undefined
        ? undefined
        : countOccurrences(normalizeScreen(before), needle) + countOccurrences(normalized, needle);
    await waitFor(
      pane,
      socket,
      subshellId,
      now,
      now() + (opts.renderTimeoutMs ?? RENDER_GATE_TIMEOUT_MS),
      opts.pollMs,
      (screen) => expectedCount !== undefined && countOccurrences(normalizeScreen(screen), needle) >= expectedCount,
    );
    // Rendering doesn't necessarily end a TUI's paste burst. Give its input
    // parser a quiet interval before Enter, or Codex can insert a newline
    // into the composer instead of submitting the visible text.
    await Bun.sleep(200);
  }
  await pane.pressEnter(socket, subshellId);
}

/**
 * One polling loop shared by the settle and render-gate phases: capture,
 * test, sleep, until the predicate holds or the deadline passes. Capture
 * errors count as "not yet".
 * @returns the screen that passed, or undefined if the budget ran out
 */
async function waitFor(
  pane: PromptDeliveryPane,
  socket: string,
  subshellId: string,
  now: () => number,
  deadline: number,
  pollMs: number,
  predicate: (screen: string) => boolean,
): Promise<string | undefined> {
  while (true) {
    try {
      const screen = await pane.capturePane(socket, subshellId);
      if (predicate(screen)) return screen;
    } catch {
      // pane not queryable yet; keep polling
    }
    if (now() >= deadline) return undefined;
    await Bun.sleep(pollMs);
  }
}
