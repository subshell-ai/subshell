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
 * exactly that between the type and the Enter.
 */

/** The pane operations delivery needs; `TmuxRunner` is the production filler. */
export interface PromptDeliveryPane {
  capturePane(socket: string, subshellName: string, scrollbackLines?: number): Promise<string>;
  sendInput(socket: string, subshellName: string, input: string): Promise<void>;
  pressEnter(socket: string, subshellName: string): Promise<void>;
}

/** Timing knobs, all on the caller's clock: the server owns the one policy
 * and sends the same numbers to a node over the `prompt_deliver` wire. */
export interface PromptDeliveryOptions {
  /** Budget for the WHOLE delivery: settle wait plus render-gate wait. */
  settleTimeoutMs: number;
  /** Poll interval for both capture loops. */
  pollMs: number;
  /** Clock seam; tests own time, production reads `Date.now`. */
  nowMs?: () => number;
}

/**
 * How much of the normalized prompt must appear in the capture before Enter
 * goes. The whole text is too strict (a harness may still be rendering the
 * tail, and a narrow pane scrolls the head off), the first few characters are
 * too weak (a shell prompt can collide with them).
 */
const RENDER_NEEDLE_MAX_CHARS = 48;

/** Whitespace runs carry no meaning for the render check: the pane wraps, and
 * Claude Code eats raw LFs out of a burst. Both sides normalize identically. */
function normalizeScreen(text: string): string {
  return stripAnsi(text).replace(/\s+/g, "");
}

/**
 * Types `text` into a freshly-spawned pane once it shows output, then submits
 * with Enter — holding the Enter until the pane proves it rendered the typed
 * text, because an Enter that reaches a not-yet-mounted harness is swallowed
 * (see the file note). Returns whether the prompt was delivered: a pane that
 * never shows anything, or an input command that fails, reports `false`
 * rather than typing blind. A pane that never echoes the text (masked input,
 * a dialog that hides keystrokes) still gets its Enter when the budget runs
 * out — that is the pre-gate behavior, and better than no submit at all.
 *
 * @param pane - the capture/send/enter trio (the `TmuxRunner`)
 * @param socket - the tmux socket the pane lives on
 * @param subshellId - the pane's tmux session name
 * @param text - the prompt to type; the caller trims it
 * @param opts - budget, poll pacing, and the clock seam
 */
export async function deliverPromptInto(
  pane: PromptDeliveryPane,
  socket: string,
  subshellId: string,
  text: string,
  opts: PromptDeliveryOptions,
): Promise<boolean> {
  const now = opts.nowMs ?? Date.now;
  const deadline = now() + opts.settleTimeoutMs;

  // Settle: a blank pane is still booting; swallow capture errors (the pane
  // is simply not queryable yet) and keep polling. ANSI control codes alone
  // are not output — a screen holding only a reset sequence is still blank.
  if (
    !(await waitFor(pane, socket, subshellId, now, deadline, opts.pollMs, (screen) => normalizeScreen(screen) !== ""))
  ) {
    return false;
  }

  try {
    await pane.sendInput(socket, subshellId, text);
  } catch {
    // an input failure is a false answer, never a throw — the caller decides
    return false;
  }

  // Render gate: the text coming back on the screen is the proof the harness
  // is reading its input, so Enter only enters the same queue the keystrokes
  // are living in. On timeout the Enter goes anyway.
  const needle = normalizeScreen(text).slice(0, RENDER_NEEDLE_MAX_CHARS);
  if (needle !== "") {
    await waitFor(pane, socket, subshellId, now, deadline, opts.pollMs, (screen) =>
      normalizeScreen(screen).includes(needle),
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
 * @returns true when the predicate held inside the budget
 */
async function waitFor(
  pane: PromptDeliveryPane,
  socket: string,
  subshellId: string,
  now: () => number,
  deadline: number,
  pollMs: number,
  predicate: (screen: string) => boolean,
): Promise<boolean> {
  while (true) {
    try {
      if (predicate(await pane.capturePane(socket, subshellId))) return true;
    } catch {
      // pane not queryable yet; keep polling
    }
    if (now() >= deadline) return false;
    await Bun.sleep(pollMs);
  }
}
