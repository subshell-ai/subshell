import { stripAnsi } from "@internal/backend-errors";

/**
 * The create/restart prompt-delivery policy, shared by the two delivery
 * sites (the control plane's `LocalLauncher.deliverPrompt` and the node's
 * `prompt_deliver` executor) so one settle rule governs both instead of two
 * mirrors that drift.
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
 * How much of the normalized prompt must appear in the capture before Enter
 * goes. The whole text is too strict: a harness mid-render may show the head
 * but not the tail. A narrow pane is not a risk — `normalizeScreen` joins
 * wrapped rows, so the text reads the same however the pane broke it.
 */
const RENDER_NEEDLE_MAX_CHARS = 48;

/**
 * The gate's budget when the caller names none. Kept inside the shared module
 * rather than split across the two callers, so a node running under an older
 * server (the wire frame carries no gate field) and the control plane share
 * one gate budget.
 */
const RENDER_GATE_TIMEOUT_MS = 10_000;

/** Whitespace runs carry no meaning for the render check: the pane wraps, and
 * Claude Code eats raw LFs out of a burst. Both sides normalize identically. */
function normalizeScreen(text: string): string {
  return stripAnsi(text).replace(/\s+/g, "");
}

/** Non-overlapping count of `needle` in `haystack`, for the delta rule.
 * An empty needle answers 0: `indexOf` would match at zero forever. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
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
 * `settleTimeoutMs + renderTimeoutMs`, still inside the remote RPC's
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
    await pane.sendInput(socket, subshellId, text);
  } catch {
    // an input failure is a false answer, never a throw — the caller decides
    return false;
  }

  // Render gate: an OCCURRENCE of the prompt appearing since the settle frame
  // is the proof the harness is reading its input, so Enter only enters the
  // same queue the keystrokes are living in. Counting occurrences beats mere
  // presence or screen-change: a spinner repainting every poll keeps the count
  // constant while the banner a short prompt hides inside keeps riding along,
  // and only the harness's own echo into the input box adds one. The known
  // limit: a pane whose first partial paint lacks the prompt's head and
  // finishes painting it (untriggered by the typing) after the baseline frame
  // matches the count for the wrong reason; the gate then behaves like the
  // pre-gate code did — Enter goes a bit early. No cheaper screen test tells
  // those pixels apart. On timeout the Enter goes anyway.
  const needle = normalizeScreen(text).slice(0, RENDER_NEEDLE_MAX_CHARS);
  if (needle !== "") {
    const baselineCount = countOccurrences(normalizeScreen(settled), needle);
    await waitFor(
      pane,
      socket,
      subshellId,
      now,
      now() + (opts.renderTimeoutMs ?? RENDER_GATE_TIMEOUT_MS),
      opts.pollMs,
      (screen) => countOccurrences(normalizeScreen(screen), needle) > baselineCount,
    );
  }

  try {
    await pane.pressEnter(socket, subshellId);
  } catch {
    return false;
  }
  return true;
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
