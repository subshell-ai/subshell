import { TmuxRunner } from "@internal/pane-runtime";
import { IS_TEST } from "@/constants.js";
import { getRequestlessContext } from "@/lib/context.js";
import { readManagedPane } from "@/services/pane-ssh-gate.js";
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
 *
 * Managed SSH panes are REFUSED here explicitly (review M2): a nudge is
 * automated input, and the only sanctioned door for automated input to a
 * managed pane is the generation-stamped SSH input seam (`input` surface +
 * `SshPaneHooks.sendManagedInput`), which this raw-transport path bypasses.
 * The node-side generation fence would already drop the frame (no generation
 * on a managed pane = stale), but refusing at the plane makes the posture
 * legible and costs one PK read. The `ssh_panes` row is the whole test.
 *
 * AWAITED, not fired and forgotten, even though the caller does not need the
 * answer: the two tmux commands are async now, and a rejection nobody handles
 * is an unhandled rejection rather than the debug line below. The pane chain
 * in `TmuxRunner` already guarantees the Enter follows the text, so the await
 * buys error handling rather than ordering.
 */
export async function nudgeSubshell(
  socket: string,
  subshellId: string,
  text: string,
  opts: { submit?: boolean } = {},
): Promise<void> {
  try {
    if (await readManagedPane(getRequestlessContext().db, subshellId)) {
      logger.debug(`nudge refused for ${subshellId} (managed SSH pane: automated input rides the gated seam)`);
      return;
    }
    await transport.sendInput(socket, subshellId, text);
    if (opts.submit) await transport.pressEnter(socket, subshellId);
  } catch (err) {
    // A vanished pane between liveness-check and type is a normal race.
    logger.withError(err).debug(`nudge failed for ${subshellId}`);
  }
}
