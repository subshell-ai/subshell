import { TmuxRunner } from "@internal/harnesses";
import { IS_TEST } from "@/constants.js";
import { logger } from "@/utils/logger.js";

/**
 * Tmux seam for nudging idle subshells about new channel posts.
 *
 * A nudge is a fixed, server-generated line typed into the pane WITHOUT
 * Enter — it can interrupt nothing and submits nothing; a human or an agent
 * that later hits Enter just edits harmless text. Only the nudge path may
 * write to a pane from REST (arbitrary input stays WS/browser-only).
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

/** Best-effort: types the line into the subshell's pane, never throws. */
export function nudgeSubshell(socket: string, subshellName: string, text: string): void {
  try {
    transport.sendInput(socket, subshellName, text);
  } catch (err) {
    // A vanished pane between liveness-check and type is a normal race.
    logger.withError(err).debug(`nudge failed for ${subshellName}`);
  }
}
