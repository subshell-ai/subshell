import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { publishLive } from "@/services/live-bus.js";
import { forgetRuntimeLauncher } from "@/services/nodes/launcher-registry.js";
import { announceNodePresence } from "@/services/nodes/node-presence-announce.js";
import { revokeSubshellToken } from "@/services/subshell-tokens.js";
import { logger } from "@/utils/logger.js";
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
      for (const row of rows) {
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
  // runtime had already reported exited was settled by the exit event).
  for (const paneId of session.paneIds()) {
    await subshellsRepo.update(paneId, { alive: 0 }).catch(() => {});
    session.unregisterPane(paneId);
    await revokeSubshellToken(paneId).catch(() => {});
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
  // beats waiting for a reader's probe. The next session's reconcile re-adopts.
  for (const paneId of session.paneIds()) {
    await subshellsRepo.update(paneId, { alive: 0 }).catch(() => {});
    session.unregisterPane(paneId);
    await revokeSubshellToken(paneId).catch(() => {});
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
