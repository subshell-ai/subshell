import { stopAllProcesses } from "@/services/network/supervisor.js";
import { disconnectAllNodes } from "@/services/nodes/node-registry.js";
import { logger } from "@/utils/logger.js";
import { closeAllViewers } from "@/ws/viewers.js";

/**
 * WebSocket close code "Service Restart" (RFC 6455 § 7.4.1 registry). Below
 * 4000 on purpose: the SPA's socket treats the 4xxx range as a refusal to be
 * reported and anything below it as a connection to retry.
 */
export const WS_CLOSE_SERVICE_RESTART = 1012;

/** What both sides are told when the server is going down to come back. */
const RESTART_REASON = "server restart";

/** Injectable seams, so a test can drive the whole sequence without exiting the test process. */
export interface RestartDeps {
  /** How long after the call the shutdown begins; the route's 202 must flush first (default 250 ms). */
  delayMs?: number;
  /** Browser terminal sockets (production: `closeAllViewers`). */
  closeViewers?: (code: number, reason: string) => number;
  /**
   * Node agent sockets (production: `disconnectAllNodes`, which projects
   * each evicted node offline before answering, so the restart may await
   * it; test stubs may return a plain count).
   */
  closeNodes?: (code: number, reason: string) => number | Promise<number>;
  /** Process exit (production: `process.exit`). */
  exit?: (code: number) => void;
  /**
   * Supervised network children (production: `stopAllProcesses`).
   *
   * They are children of THIS process and nothing else reaps them, so an exit
   * that skipped this would leave a tunnel pointing at a port that is about to
   * stop answering — which is worse than no tunnel, because it stays
   * resolvable for as long as the restart takes.
   */
  stopProcesses?: () => Promise<void>;
  /** Timer (production: `setTimeout`). */
  setTimer?: typeof setTimeout;
}

/**
 * Restart by EXITING: the service manager brings the process back
 * (`Restart=always`/`RestartSec=5` on systemd, `KeepAlive=true` under
 * launchd, both of which respawn on any exit status). Only ever called after
 * `isSupervised` said the manager's own pid is this process — otherwise this
 * would be a shutdown wearing a restart's name.
 *
 * Both socket populations are closed first so each side sees a clean 1012 and
 * reconnects, rather than discovering a dropped connection. SQLite needs no
 * close: bun:sqlite releases on exit and the WAL is durable.
 *
 * The delay is what lets the route's own 202 reach the caller — it carries
 * `resumeAt`, which a caller whose address is about to change needs before the
 * connection goes.
 */
export function performRestart(deps: RestartDeps = {}): void {
  const timer = deps.setTimer ?? setTimeout;
  const closeViewers = deps.closeViewers ?? closeAllViewers;
  const closeNodes = deps.closeNodes ?? disconnectAllNodes;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const stopProcesses = deps.stopProcesses ?? stopAllProcesses;
  timer(async () => {
    // The callback is async and its promise has no observer — a throw from
    // either closer would reject it, skip the rest of the shutdown, and leave
    // the process ALIVE forever after the route's 202 flushed. That is the
    // restart wearing a hang's name, and it became reachable the moment the
    // node half grew its awaited offline-projection. Neither closer's failure
    // is a reason to stay up: the sockets are already half-closed by the
    // dying process itself, and the manager is bringing this process back.
    try {
      closeViewers(WS_CLOSE_SERVICE_RESTART, RESTART_REASON);
      // Awaited: the production closer projects each node row offline as it
      // evicts, and that must be true of the database before the exit the
      // same restart hands to the manager.
      await closeNodes(WS_CLOSE_SERVICE_RESTART, RESTART_REASON);
    } catch (err) {
      logger.withError(err).warn("restart: socket teardown failed — completing the shutdown anyway");
    } finally {
      // The sockets are closed first and the children stopped after, so the
      // browser is already reconnecting while a daemon takes its SIGTERM
      // grace. The exit waits for the reap rather than racing it: a tunnel
      // outliving its server is the one outcome a restart must not produce,
      // and a failure to stop one is not a reason to stay up. The
      // `Promise.resolve().then(...)` shape is what makes THAT rule true of a
      // stopper that throws SYNCHRONOUSLY as well as one that rejects — a
      // bare `stopProcesses()` call inside `finally` would escape before the
      // `.catch` could hold it, and the exit chained after it would never
      // fire.
      Promise.resolve()
        .then(stopProcesses)
        .catch(() => {})
        .finally(() => exit(0));
    }
  }, deps.delayMs ?? 250);
}
