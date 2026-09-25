import { getRequestlessContext } from "@/lib/context.js";
import { publishLive } from "@/services/live-bus.js";
import { logger } from "@/utils/logger.js";

/**
 * Typing into a pane answers its unseen push (spec 2026-09-23's "the owner
 * has answered by opening the pane", completed 2026-09-25).
 *
 * The two events that answered a push before this were both BOUNDARIES: the
 * detail read (GET /:id) and the terminal attach. A push that lands while the
 * owner is already looking, already attached, and typing into the pane had no
 * answering event at all — the bell sat on the row until the next reload,
 * which reads as the flag never clearing. A keystroke IS the owner's
 * attention, so the input branch of `handleSubshellMessage` calls this on
 * every typed frame.
 *
 * That per-keystroke shape is safe because the write is CONDITIONAL
 * (`clearUnseenPushIfSet`): the first frame clears and announces; every
 * later frame runs a 0-row UPDATE against an indexed primary key and
 * announces nothing. Best-effort like the two boundary sites: the owner's
 * typing must never fail because of a bookkeeping write, and an uncleared
 * urgency costs at most one escalation, never a pane.
 *
 * The 0-row steady-state write stays UNmemoized deliberately: a socket-held
 * "already answered" flag would need a reset at the push-delivery site (the
 * only writer of a new urgency), and a stale TRUE there re-creates the exact
 * bug this seam fixes, silently. An indexed 0-row UPDATE is the cheaper risk.
 */
export async function answerUnseenPush(subshellId: string): Promise<void> {
  try {
    const { repos } = getRequestlessContext();
    if ((await repos.subshells.clearUnseenPushIfSet(subshellId)) > 0) {
      publishLive({ kind: "subshell.changed", id: subshellId });
    }
  } catch (err) {
    // A per-keystroke failure must not spam the journal: warn once per frame
    // only means once per failure, since the common frame is the 0-row no-op
    // that never reaches a log line.
    logger.withError(err).warn(`unseen-push input-answer failed for ${subshellId} (escalation may double)`);
  }
}
