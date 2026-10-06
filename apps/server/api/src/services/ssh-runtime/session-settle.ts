import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { publishLive } from "@/services/live-bus.js";
import { forgetRuntimeLauncher } from "@/services/nodes/launcher-registry.js";
import { announceNodePresence } from "@/services/nodes/node-presence-announce.js";
import { revokeSubshellToken } from "@/services/subshell-tokens.js";
import { logger } from "@/utils/logger.js";
import { closeViewersForSubshell } from "@/ws/viewers.js";
import type { SessionLossReason, SshRuntimeSession } from "./session.js";
import { setSessionSettlers, unregisterSession } from "./session-registry.js";
import { SshRuntimeSessionsRepository } from "./sessions.repository.js";

/**
 * The settle half of the runtime-session service (design 2026-10-05 §4/§6):
 * what the DB and the pane rows say when a session is lost, closed, reported,
 * or when a plane restart left stale rows behind. The service module installs
 * these handlers once at load (`installSessionSettlers`); the byte channel in
 * `session.ts` calls them through the registry's hook object and owns nothing
 * below this line.
 *
 * The asymmetry that shapes every function here: the registry is authority
 * for liveness, the row is history. Settling therefore WRITES (row, node
 * status, pane `alive`, token revocation) and never re-opens anything; lost
 * sessions and closed ones are final, and a boot sweep is the same rule
 * applied by a process that can no longer hold any channel at all.
 */

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const nodesRepo = new NodesRepository(db);
const subshellsRepo = new SubshellsRepository(db);

/**
 * Membership: an id is settleable by THIS session only if the session issued
 * its pane token (review I4). The reported census/exit ids are remote output
 * - design §8 says remote output is untrusted data - and the runtime naming
 * a syntactically-valid foreign id must buy it nothing: no row flip, no
 * revoke, no publish. The settle-all paths iterate `session.paneIds()` and
 * get the same guarantee structurally.
 */
function isSessionPane(session: SshRuntimeSession, subshellId: string): boolean {
  return session.paneIds().includes(subshellId);
}

/** The one honest record of a refused id: a debug line, never a silent write. */
function skipUnowned(session: SshRuntimeSession, what: "exit" | "report", subshellId: string): void {
  logger.debug(
    `ssh-runtime settle: refused ${what} for ${subshellId.slice(0, 8)} (not a pane of session ${session.id.slice(0, 8)})`,
  );
}

/**
 * Install the settle handlers on the shared hook object (called once, from
 * the service module's load, before any session exists - the registry's
 * injection seam exists so neither module imports the other in a cycle).
 */
export function installSessionSettlers(): void {
  setSessionSettlers({
    onLost: (session, reason) => {
      void settleLost(session, reason);
    },
    onClosed: (session) => {
      void settleClosed(session);
    },
    onPaneExit: (session, subshellId, exitCode) => {
      // Membership FIRST (review I4, design §8: remote output is untrusted).
      // A syntactically-valid id this session never issued is another
      // session's pane or an agent node's row; a lying or confused runtime
      // must not be able to flip it, revoke its token, or announce it.
      // Unknown ids are SKIPPED, the same posture `session-adopt.ts` models.
      if (!isSessionPane(session, subshellId)) {
        skipUnowned(session, "exit", subshellId);
        return;
      }
      // The row keeps `status` (the outcome it witnessed or never saw) and
      // `alive` goes 0 - design §6's "unavailable, not completed" for a pane
      // whose death the runtime itself reported (the runtime's own exit watcher
      // is the witness here; unlike a lost channel, this one KNOWS).
      void subshellsRepo.update(subshellId, { alive: 0, exitCode: exitCode ?? 0 }).catch(() => {});
      session.unregisterPane(subshellId);
      void revokeSubshellToken(subshellId).catch(() => {});
      publishLive({ kind: "subshell.changed", id: subshellId });
    },
    onReport: (session, rows) => {
      // The census: delivered from the `subshells_report` event arm AND from
      // the `close` command's result (design §6's final report - see
      // `SshRuntimeSession.close`). Dead panes get their exit codes and leave
      // the registry (their tokens die with them); live ones keep their row.
      // The same membership rule as `onPaneExit` reads every row (review I4):
      // the settle-all paths below iterate `session.paneIds()` and need no
      // guard; these REPORTED ids are remote data until proven members.
      for (const row of rows) {
        if (!isSessionPane(session, row.subshellId)) {
          skipUnowned(session, "report", row.subshellId);
          continue;
        }
        void subshellsRepo
          .update(row.subshellId, { alive: row.alive ? 1 : 0, ...(row.alive ? {} : { exitCode: row.exitCode ?? 0 }) })
          .catch(() => {});
        if (!row.alive) {
          session.unregisterPane(row.subshellId);
          void revokeSubshellToken(row.subshellId).catch(() => {});
        }
        publishLive({ kind: "subshell.changed", id: row.subshellId });
      }
    },
  });
}

/** The lost settling: one transition's writes, idempotent through the registry's status guard. */
async function settleLost(session: SshRuntimeSession, reason: SessionLossReason): Promise<void> {
  unregisterSession(session);
  forgetRuntimeLauncher(session.runtimeNodeId);
  await sessionsRepo.settle(session.id, "lost", null).catch(() => {});
  await nodesRepo.setStatus(session.runtimeNodeId, "offline").catch(() => {});
  // Panes: unavailable, not completed (design §6). The row keeps `status`;
  // `alive` flips 0 for every pane the session still carries (a pane the
  // runtime had already reported exited was settled by the exit event). A
  // browser terminal watching one learns the same truth NOW: the session's
  // channel is gone, so the relay's stream is over - `closeViewersForSubshell`
  // (1012, the retry convention) ends it, and the client's reconnect meets the
  // 4004 the attach path gives a dead session. Unavailable, never completed.
  for (const paneId of session.paneIds()) {
    await subshellsRepo.update(paneId, { alive: 0 }).catch(() => {});
    session.unregisterPane(paneId);
    await revokeSubshellToken(paneId).catch(() => {});
    closeViewersForSubshell(paneId, "session lost");
    publishLive({ kind: "subshell.changed", id: paneId });
  }
  announceNodePresence(session.runtimeNodeId);
  logger.debug(`ssh-runtime session ${session.id.slice(0, 8)} settled lost (${reason})`);
}

/** The closed settling: same shape, different word, and the runtime row goes offline too (the channel is gone by definition). */
async function settleClosed(session: SshRuntimeSession): Promise<void> {
  unregisterSession(session);
  // The per-session launcher cache leaves with the session (the plaintext
  // pane-token map rides the launcher's session reference; holding the entry
  // would outlive the documented "leaves with the pane" promise).
  forgetRuntimeLauncher(session.runtimeNodeId);
  await sessionsRepo.settle(session.id, "closed", null).catch(() => {});
  await nodesRepo.setStatus(session.runtimeNodeId, "offline").catch(() => {});
  // A graceful close still leaves the destination's panes RUNNING on the
  // tmux server (design §6 Close). The census (delivered through `onReport`
  // BEFORE this settling) recorded each pane as the destination saw it; the
  // plane's rows then flip survivors to `alive: 0` anyway, because "alive
  // with a dead session" is exactly the unavailable reading, and a flip here
  // beats waiting for a reader's probe. The next session's reconcile
  // re-adopts them (`session-adopt.ts`, design §6's idempotent restore).
  // Live terminals go with the channel: `closeViewersForSubshell` (1012),
  // the same close the lost settling gives - the destination pane may still
  // be running, but THIS plane cannot stream it until a session carries it.
  for (const paneId of session.paneIds()) {
    await subshellsRepo.update(paneId, { alive: 0 }).catch(() => {});
    session.unregisterPane(paneId);
    await revokeSubshellToken(paneId).catch(() => {});
    closeViewersForSubshell(paneId, "session closed");
    publishLive({ kind: "subshell.changed", id: paneId });
  }
  announceNodePresence(session.runtimeNodeId);
}

/**
 * The boot sweep (design §6's lost-marking surviving a plane restart):
 * `opening`/`active` rows can only be history by now - the byte channels died
 * with the previous process, and their SSH children went with the old broker
 * link. Every such row becomes `lost`, its hidden runtime node goes
 * `offline`, and the presence re-announces so an open page stops showing the
 * machine as up. Panes keep `status` with `alive` as found (the sweep never
 * witnessed a pane outcome; design §6's unavailable reading comes from the
 * offline node).
 *
 * Called ONCE from the boot sequence (the registry can never re-open a swept
 * row; there is nothing to poll for).
 *
 * @returns the ids swept (the boot log counts them)
 */
export async function reconcileSshRuntimeSessionsAtBoot(): Promise<string[]> {
  const swept = await sessionsRepo.reconcileAtBoot();
  for (const id of swept) {
    const row = await sessionsRepo.findById(id);
    if (row) announceNodePresence(row.runtimeNodeId);
  }
  if (swept.length > 0) {
    logger.info(`ssh-runtime boot reconcile: ${swept.length} stale session row(s) marked lost, runtime nodes offline`);
  }
  return swept;
}
