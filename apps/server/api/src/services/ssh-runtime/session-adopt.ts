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
 *   runtime node, `alive` restored. Its MCP token was revoked at the loss or
 *   close, and the pane holds no key (design §5 - the plaintext never left
 *   the plane), so the token ROTATES on the same row exactly the restart
 *   path rotates it (`#reviveRow`): revoke, re-mint, register on the new
 *   session's `#paneTokens`. The destination's per-pane callback door was
 *   rebuilt by the runtime from its own meta store (doors are
 *   destination-stable by design), and the fresh registration is what lets
 *   the re-created door's callbacks attribute again.
 * - **Reported dead, or not reported at all, row exists** - the row settles
 *   terminated as today's settle does: `alive: 0`, token dead. This also
 *   catches the boot sweep's leftovers (rows it left `alive` because it
 *   witnessed no outcome): the fresh census IS a witnessed reading now.
 * - **Reported, no row** - recorded and SKIPPED. There is no census-insert
 *   path (deliberately, and it stays that way): a pane the plane never
 *   created gets no row, because minting one here would invent an owner, a
 *   name, and a working dir the plane never launched. The debug line names
 *   the count, so a dataDir collision (a different runtime root claiming the
 *   same destination socket) is at least observable.
 *
 * Duplicates are impossible by construction: every touched id is a row id
 * matched from the census, and ids are unique rows.
 *
 * The OLD hidden runtime node rows are kept, `status: offline`, as history -
 * the same reading `settleLost`/`settleClosed` write at loss time; the
 * session rows still name them, deleting would break that history for zero
 * concealment gain (the kind is already never-listed, never-dialable).
 *
 * Every step is guarded on the session still being ACTIVE: a session that
 * dies mid-reconcile stops the walk, and the rows it had not reached keep the
 * settled-session reading. Whatever it had reached is re-adoptable by the
 * NEXT open, because the new settled session's runtime node joins the
 * candidate set - the idempotence §6 names.
 */

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const subshellsRepo = new SubshellsRepository(db);

/** What one reconcile pass did (the debug line and the service test). */
export interface AdoptSummary {
  /** Row ids flipped onto the new session's runtime node, tokens rotated. */
  adopted: string[];
  /** Row ids confirmed dead (census said so, or never said otherwise). */
  settledDead: string[];
  /** Census ids with no plane row (recorded, skipped). */
  unknown: string[];
  /** Why nothing ran: the census round trip refused, or the session died. */
  skipped: "census-failed" | "session-inactive" | null;
}

/** Census + restore for one freshly-opened session. Never throws: a failed reconcile must not fail a good open. */
export async function adoptReconciledPanes(session: SshRuntimeSession): Promise<AdoptSummary> {
  const summary: AdoptSummary = { adopted: [], settledDead: [], unknown: [], skipped: null };
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
          .select(["id", "userId", "alive"])
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

  for (const row of candidateRows) {
    if (session.status !== "active") {
      // Died mid-walk: stop flipping. Rows already adopted ride the dead
      // session's settle (alive 0, token revoked by `settleLost`); rows not
      // reached keep their settled reading. The next open restores both sets.
      summary.skipped = "session-inactive";
      break;
    }
    if (aliveIds.has(row.id)) {
      // Token rotation on the same row, the restart path's pair (the old
      // process is gone and its baked key must die with it; the new life of
      // this pane bakes the freshly issued one - and nothing is transmitted:
      // the plaintext goes only into `#paneTokens`).
      await revokeSubshellToken(row.id).catch(() => {});
      const token = await issueSubshellToken(row.id, row.userId);
      session.registerPane(row.id, token);
      await subshellsRepo.update(row.id, { nodeId: session.runtimeNodeId, alive: 1 });
      summary.adopted.push(row.id);
    } else {
      // Reported dead or absent: unavailable/terminated as settled - flip
      // explicitly (the boot-sweep leftover may still say alive:1) and make
      // sure no live token is left minted for a dead pane.
      if (row.alive === 1) await subshellsRepo.update(row.id, { alive: 0 });
      await revokeSubshellToken(row.id).catch(() => {});
      summary.settledDead.push(row.id);
    }
    publishLive({ kind: "subshell.changed", id: row.id });
  }

  // Reported-but-unknown: recorded and skipped (module doc). A census id with
  // no plane row is a pane the plane never created - never a row to invent.
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
