import { parseSshRuntimeReportRows, type SshRuntimeReportRow } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { publishLive } from "@/services/live-bus.js";
import { issueSubshellToken, revokeSubshellToken } from "@/services/subshell-tokens.js";
import { logger } from "@/utils/logger.js";
import { SshRuntimeCommandError, type SshRuntimeSession } from "./session.js";
import { SshRuntimeSessionsRepository } from "./sessions.repository.js";

/**
 * Re-adoption: design 2026-10-05 §6's "plane matches reported pane ids to
 * existing rows (idempotent restore)", executed when a session opens onto a
 * destination whose earlier settled (lost or closed) sessions left panes
 * running on the deterministic tmux socket.
 *
 * The mechanism, per pane id the fresh runtime reports:
 *
 * - **Reported alive, row exists on a settled session's runtime node** - the
 *   row is FLIPPED, not copied: same id, `nodeId` moves to the new hidden
 *   runtime node, `alive` restored. The flip is CONDITIONAL on the row still
 *   sitting on the settled node this walk snapshotted it from
 *   (`updateIfOnNode`): two concurrent reopens of one destination can both
 *   hold the row in their candidate snapshots, and exactly one of them wins
 *   the move - the loser stands down entirely (no revoke, no mint, no
 *   registration), leaving the row to its winner. On its own walk the winner
 *   rotates the row's token exactly the restart path rotates it (`#reviveRow`
 *   - revoke, re-mint, register on this session's `#paneTokens`): the token
 *   was revoked at the loss or close, and the pane holds no key (design §5 -
 *   the plaintext never left the plane). The destination's per-pane callback
 *   door was rebuilt by the runtime from its own meta store (doors are
 *   destination-stable by design), and the fresh registration is what lets
 *   the re-created door's callbacks attribute again.
 * - **Reported dead, or not reported at all, row exists** - the row settles
 *   terminated as today's settle does: `alive: 0`, token dead. This also
 *   catches the boot sweep's leftovers (rows it left `alive` because it
 *   witnessed no outcome): the fresh census IS a witnessed reading now.
 * - **Reported but not adopted by this walk** - recorded in `unknown` and
 *   SKIPPED. The membership: panes the plane never created here (no row at
 *   all - there is no census-insert path, deliberately, and it stays that
 *   way: a pane the plane never created gets no row, because minting one here
 *   would invent an owner, a name, and a working dir the plane never
 *   launched), plus ids whose rows this walk does not own (panes already
 *   running under THIS session, or rows settled on a different destination).
 *   The debug line names the count, so a dataDir collision (a different
 *   runtime root claiming the same destination socket) is at least
 *   observable.
 *
 * The OLD hidden runtime node rows are kept, `status: offline`, as history -
 * the same reading `settleLost`/`settleClosed` write at loss time; the
 * session rows still name them, deleting would break that history for zero
 * concealment gain (the kind is already never-listed, never-dialable).
 *
 * Every step is guarded on the session still being ACTIVE: at the row, after
 * the flip, and after the rotation. A session that dies mid-reconcile stops
 * the walk, and a row this walk had just flipped is settled back down HERE
 * (alive: 0, no live token, no registration) - the settle's own pane snapshot
 * races the registration and may miss it, so relying on it would leave an
 * `alive: 1` row and a live token on a settled session. Rows not reached keep
 * their settled reading. Whatever any of these paths left is re-adoptable by
 * the NEXT open - the just-settled session's runtime node joins the candidate
 * set - the idempotence §6 names.
 */

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const subshellsRepo = new SubshellsRepository(db);

/** What one reconcile pass did (the debug line and the service test). */
export interface AdoptSummary {
  /** Row ids flipped onto the new session's runtime node, tokens rotated. */
  adopted: string[];
  /** Row ids confirmed dead (census said so, or never said otherwise). */
  settledDead: string[];
  /** Census ids this walk did not adopt: no plane row, or not its candidate (module doc). */
  unknown: string[];
  /** Row ids whose step threw: caught, recorded, skipped (the best-effort posture). */
  failed: string[];
  /** Why nothing ran (or stopped early): the census round trip refused, or the session died. */
  skipped: "census-failed" | "session-inactive" | null;
}

/**
 * Census + restore for one freshly-opened session. Best-effort by rule: a
 * refused census collapses into `skipped`, and a throwing ROW step is caught,
 * recorded on `failed`, and walked past - a failing reconcile never fails a
 * good open, and never abandons the rows behind the failure either. (The
 * candidate reads BEFORE the walk are not wrapped; a throwing query there
 * still rides the call site's `.catch` at the open seam.)
 */
export async function adoptReconciledPanes(session: SshRuntimeSession): Promise<AdoptSummary> {
  const summary: AdoptSummary = { adopted: [], settledDead: [], unknown: [], failed: [], skipped: null };
  if (session.status !== "active") {
    summary.skipped = "session-inactive";
    return summary;
  }

  // The candidate rows FIRST, from the plane's own tables: everything still
  // pinned to a settled session's hidden runtime node for THIS destination
  // (owner + host/port/user - the same material the deterministic socket
  // hashes from). The fresh session's own rows can never appear: its node row
  // is new, and candidate sessions are exactly the lost/closed ones. With no
  // candidates there is NOTHING a census could change (reported-but-unknown
  // ids never get a row - module doc), so the first open onto a fresh
  // destination asks the runtime nothing at all: one round trip saved on the
  // common path, and no frame for a session that has nothing to reconcile.
  const priorRuntimeNodeIds = await sessionsRepo.settledRuntimeNodeIdsForDestination({
    ownerUserId: session.ownerId,
    host: session.target.host,
    port: session.target.port,
    user: session.target.user,
  });
  const candidateRows =
    priorRuntimeNodeIds.length === 0
      ? []
      : await db
          .selectFrom("subshells")
          .select(["id", "userId", "alive", "nodeId"])
          .where("nodeId", "in", priorRuntimeNodeIds)
          .execute();
  if (candidateRows.length === 0) return summary;

  // The census over the FRESH session (the runtime's own meta store probed
  // on the destination socket - the ids are destination truth, not a cached
  // hello count). A refusal here (dead child, timeout, malformed answer)
  // leaves every settled row as the settle wrote it: unavailable, not
  // adopted. The next open reconciles again.
  let census: SshRuntimeReportRow[] | null;
  try {
    census = parseSshRuntimeReportRows(
      await session.command({ type: "subshells_report", ref: crypto.randomUUID() }, 10_000),
    );
  } catch (err) {
    const why = err instanceof SshRuntimeCommandError ? err.detail : String(err);
    logger.debug(`ssh-runtime adopt: census refused for session ${session.id.slice(0, 8)} (${why})`);
    summary.skipped = "census-failed";
    return summary;
  }
  if (census === null) {
    logger.debug(`ssh-runtime adopt: census malformed for session ${session.id.slice(0, 8)}`);
    summary.skipped = "census-failed";
    return summary;
  }
  if (session.status !== "active") {
    summary.skipped = "session-inactive";
    return summary;
  }

  const aliveIds = new Set(census.filter((r) => r.alive).map((r) => r.subshellId));
  const knownIds = new Set(candidateRows.map((r) => r.id));

  /**
   * Settle a row this walk just flipped back down, for the session-death
   * interleave: `settleLost` snapshots its pane list AFTER its DB awaits and
   * may have raced past this row's registration (or found it unregistered -
   * a boot-sweep leftover shape), so the walk settles what it flipped:
   * `alive: 0`, the row's current token revoked (the stale one, or the one
   * this walk minted), no registration left behind. Every step is idempotent
   * against the settle's own writes, and the row - now pinned to this
   * since-settled node - is a candidate for the next open.
   */
  const settleFlippedDown = async (rowId: string): Promise<void> => {
    await subshellsRepo.update(rowId, { alive: 0 }).catch(() => {});
    await revokeSubshellToken(rowId).catch(() => {});
    session.unregisterPane(rowId);
    summary.settledDead.push(rowId);
    summary.skipped = "session-inactive";
    publishLive({ kind: "subshell.changed", id: rowId });
  };

  for (const row of candidateRows) {
    if (session.status !== "active") {
      // Died before this row: stop walking. Rows this walk reached are fully
      // adopted or settled back down (below); rows not reached keep their
      // settled reading. The next open restores both sets.
      summary.skipped = "session-inactive";
      break;
    }
    try {
      if (aliveIds.has(row.id)) {
        // Claim the row off its settled node (module doc: the loser of a
        // concurrent reopen touches NOTHING - its leading revoke/mint would
        // have raced the winner's rotation into a dead token on a live pane).
        const won = await subshellsRepo.updateIfOnNode(row.id, row.nodeId, {
          nodeId: session.runtimeNodeId,
          alive: 1,
        });
        if (won === 0) {
          logger.debug(`ssh-runtime adopt: row ${row.id.slice(0, 8)} already reparented by a concurrent reopen`);
          continue;
        }
        if (session.status !== "active") {
          await settleFlippedDown(row.id);
          break;
        }
        // Token rotation on the same row, the restart path's pair (the old
        // process is gone and its baked key must die with it; the new life of
        // this pane bakes the freshly issued one - and nothing is transmitted:
        // the plaintext goes only into `#paneTokens`).
        await revokeSubshellToken(row.id);
        const token = await issueSubshellToken(row.id, row.userId);
        session.registerPane(row.id, token);
        if (session.status !== "active") {
          // Died mid-rotation, after this row's registration: the settle's
          // snapshot may or may not have carried the pane - settle it down
          // regardless (the just-minted token dies with the session it was
          // minted for; the next open mints again).
          await settleFlippedDown(row.id);
          break;
        }
        summary.adopted.push(row.id);
      } else {
        // Reported dead or absent: unavailable/terminated as settled - flip
        // explicitly (the boot-sweep leftover may still say alive:1) and make
        // sure no live token is left minted for a dead pane.
        if (row.alive === 1) await subshellsRepo.update(row.id, { alive: 0 });
        await revokeSubshellToken(row.id);
        summary.settledDead.push(row.id);
      }
      publishLive({ kind: "subshell.changed", id: row.id });
    } catch (err) {
      // One row's failure is that row's, not the walk's (the function doc's
      // posture): record it, skip it, keep going. Whatever partially landed
      // reads as settled-or-adopted history; the next open reconciles the row
      // again - that is §6's idempotence, and why no unroll is attempted here.
      logger.debug(`ssh-runtime adopt: row ${row.id.slice(0, 8)} refused (${String(err)})`);
      summary.failed.push(row.id);
    }
  }

  // Census ids this walk did not adopt (module doc): ghosts the plane never
  // created, and rows outside this walk's candidate set (panes already
  // carrying this session's own rows). Recorded; never a row invented.
  for (const r of census) {
    if (!knownIds.has(r.subshellId)) summary.unknown.push(r.subshellId);
  }

  if (summary.adopted.length > 0 || summary.settledDead.length > 0 || summary.unknown.length > 0) {
    logger.debug(
      `ssh-runtime adopt: session ${session.id.slice(0, 8)} adopted ${summary.adopted.length}, ` +
        `settled dead ${summary.settledDead.length}, unknown ${summary.unknown.length}`,
    );
  }
  return summary;
}
