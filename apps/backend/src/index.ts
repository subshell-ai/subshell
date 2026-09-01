import { resolve } from "node:path";
import { getHarness } from "@internal/harnesses";
import { ensureSystemUser } from "@/auth/system-user.js";
import { setAuthPolicyDb } from "@/auth.js";
import { assertProdAuthSecret, DATABASE_PATH, HOST, SERVER_PORT } from "@/constants.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { startServer } from "@/server.js";
import { ensureDefaultProfilesEverywhere } from "@/services/default-profiles.js";
import { setNodeLifecycleHooks } from "@/services/nodes/node-events.js";
import { listOnline } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { sessionLogPath } from "@/services/nodes/session-paths.js";
import { getNotifyService } from "@/services/notify.service.js";
import { createIdleWatcher, IDLE_TICK_MS } from "@/services/notify-idle.js";
import { SessionManagerService } from "@/services/session-manager.service.js";
import { getLogger } from "@/utils/logger.js";
import { sweepWsTokens } from "@/ws/ws-token.js";

export type { App } from "@/server.js";

// Fail before ANYTHING (imports' side effects have run, but no DB write, no
// listener, no handler wiring): a production boot with the placeholder
// BETTER_AUTH_SECRET would sign cookies with a publicly known key. Thrown at
// module top level (not inside the boot IIFE) so the error reaches stderr as
// a real crash rather than an unhandled rejection whose console output can
// be lost to process.exit's truncation.
assertProdAuthSecret();

process.on("unhandledRejection", (reason, promise) => {
  const log = getLogger().withPrefix("[Unhandled Rejection]");
  log
    .withError(reason)
    .withMetadata({
      promise,
    })
    .fatal("Unhandled Rejection");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  const log = getLogger().withPrefix("[Uncaught Exception]");
  log.withError(error).fatal("Uncaught Exception");
  process.exit(1);
});

(async () => {
  // Name the database before the first write touches it: a migration or
  // seeding failure is undiagnosable if the log never says which file was
  // opened (the path is config-driven — `DATABASE_PATH`, default
  // ./data/mote.db — and relative to wherever the process was started).
  getLogger().info(`database: ${resolve(DATABASE_PATH)}`);

  // DB + auth tables before the HTTP listener starts.
  await runMigrations();
  await runAuthMigrations();
  setAuthPolicyDb(db);
  // Service user that owns admin-managed system keys; idempotent.
  await ensureSystemUser();
  // Upgrade backfill: existing installs get a blank "Default" profile for any
  // (user, enabled-harness) pair that has none, so no one has to create a
  // profile before their first session. Idempotent; new users get the same
  // seeding at registration. See services/default-profiles.ts.
  // Wrapped: this is a convenience sweep over healthy schema+data, and an
  // optional insert failing (SQLITE_BUSY behind a stale lock holder) must
  // never be the reason a serviceable instance refuses to boot — the next
  // boot retries, registration covers new users meanwhile.
  try {
    await ensureDefaultProfilesEverywhere(db);
  } catch (err) {
    getLogger().withError(err).warn("default-profile backfill failed at boot; will retry next start");
  }
  // Seed/repair the control-plane host's `local` node row + Everyone/edit
  // share (spec 2026-08-31 §2). Idempotent; needs the system user seeded above.
  await ensureLocalNode(db);

  await startServer({ port: SERVER_PORT, host: HOST });

  // Background housekeeping: expire WS attach tokens, reconcile tmux state.
  const sessions = new SessionsRepository(db);
  const nodes = new NodesRepository(db);
  const manager = new SessionManagerService({
    sessions,
    profiles: new ProfilesRepository(db),
  });
  // Node lifecycle events (spec §3.3/§6.3): the sweep's manager instance is
  // the hook host, so `exit` events and the reconnect `sessions_report`
  // census converge through the SAME death/revive transitions (and the same
  // in-process restart lease) as the periodic sweep. Without this the frames
  // warn-and-drop.
  setNodeLifecycleHooks({
    onExit: (nodeId, sessionId, exitCode, at) => manager.applyRemoteExit(nodeId, sessionId, exitCode, at),
    onSessionsReport: (nodeId, report) => manager.applySessionsReport(nodeId, report),
  });
  // Restore alive/exit state at boot: a backend restart mid-session must not
  // leave stale alive=1 rows (tmux sessions died with the old process).
  await manager.reconcileAll();
  setInterval(() => {
    sweepWsTokens();
    void manager.reconcileAll();
    // Offline sweep (spec §5.3): a crashed/evicted agent may never produce a
    // socket close here; staleness of `lastSeenAt` is the backstop. Nodes with
    // a LIVE socket are exempt even when their heartbeat stream stalled — the
    // registry is authoritative for reachability, and flipping their row
    // would desync the DB projection from a registry an RPC still succeeds on.
    void nodes
      .markStaleAgentsOffline(new Date(Date.now() - 45_000).toISOString(), listOnline())
      .catch((err: unknown) => getLogger().withError(err).warn("node offline sweep failed"));
  }, 60_000);

  // Quiet-output idle watcher (services/notify-idle.ts): for harnesses
  // without native attention hooks (opencode/hermes/pi) a session log that
  // stops growing means the turn is done → push + "waiting for you" stamp.
  // Hooked harnesses (claude-code) ring via their hooks; the watcher only
  // clears their waiting state on renewed output. Ticks start one
  // IDLE_TICK_MS after boot (setInterval never fires immediately); sessions
  // that were already idle never ring because the watcher seeds an
  // already-quiet log as fired — only new output re-arms it.
  const idleWatcher = createIdleWatcher({
    listRows: () => sessions.listRunning(),
    statMtimeMs: async (id) => {
      try {
        return (await Bun.file(sessionLogPath(id)).stat()).mtime.getTime();
      } catch {
        return null; // no log yet — nothing to measure
      }
    },
    harnessHasHooks: (harnessId) => getHarness(harnessId)?.supportsAttentionHooks === true,
    notifySession: async (id, kind) => {
      await getNotifyService().notifySession(id, kind);
    },
    setWaiting: async (id) => {
      await sessions.update(id, { waitingSince: new Date().toISOString() });
    },
    clearWaiting: async (id) => {
      await sessions.update(id, { waitingSince: null });
    },
  });
  setInterval(() => {
    void idleWatcher.tick(Date.now());
  }, IDLE_TICK_MS);
})();
