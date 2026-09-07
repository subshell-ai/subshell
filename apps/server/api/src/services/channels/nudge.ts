import { TmuxRunner } from "@internal/harnesses";
import { IS_TEST } from "@/constants.js";
import { logger } from "@/utils/logger.js";

/**
 * Tmux seam for nudging subshells about new channel posts.
 *
 * Two deliveries, chosen by the CALLER from the pane's state:
 * - inert (default): a fixed line typed WITHOUT Enter — interrupts nothing,
 *   submits nothing; a human or agent that later hits Enter just edits
 *   harmless text. This is all a BUSY (mid-turn) pane can safely get.
 * - `submit: true`: the line is followed by Enter, so an IDLE pane at its
 *   prompt (a waiting-for-you agent) wakes and acts on it. Only ever used
 *   with a FIXED server-generated line (never peer content), so no
 *   peer-authored text is ever auto-executed — the payload stays behind
 *   read_channel, which the woken agent calls on its own judgment.
 *
 * Only the nudge path may write to a pane from REST (arbitrary input stays
 * WS/browser-only).
 */
let transport = new TmuxRunner();

/**
 * Overrides the tmux transport (tests). The seam swaps the only writer of
 * REST-initiated pane input, so it hard-refuses to run outside the test
 * suite — same guard as `setHasUsersProbeForTests` in `setup.route.ts`.
 * @internal
 */
export function setNudgeTransportForTests(tmux: TmuxRunner | null): void {
  if (!IS_TEST) throw new Error("setNudgeTransportForTests is a test-only seam");
  transport = tmux ?? new TmuxRunner();
}

/**
 * Best-effort: types the fixed line into the subshell's pane, never throws.
 * `submit` adds the Enter that wakes an idle agent (see the module doc); the
 * line passed MUST be server-generated, never peer content.
 */
export function nudgeSubshell(
  socket: string,
  subshellName: string,
  text: string,
  opts: { submit?: boolean } = {},
): void {
  try {
    transport.sendInput(socket, subshellName, text);
    if (opts.submit) transport.pressEnter(socket, subshellName);
  } catch (err) {
    // A vanished pane between liveness-check and type is a normal race.
    logger.withError(err).debug(`nudge failed for ${subshellName}`);
  }
}
