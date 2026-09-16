// LOAD-BEARING IMPORT ORDER — do not re-sort this block. The entry prelude
// must be the FIRST import in the graph: it applies the config.env layer
// before `@/constants.js` runs dotenvx (which only fills unset keys — this
// ordering is what implements `config.env > .env`), and it dispatches CLI
// subcommands before any of the modules below evaluate. ESM evaluates imports
// before body statements, so a body statement could not claim this position.
// The invariant keeping CLI runs pure is that the whole graph is IO-FREE AT
// IMPORT (lazy `getAuth()` — no module opens SQLite or binds a port merely by
// being evaluated; pinned by cli-entry.test.ts), NOT that the dispatch must
// not SUSPEND: sync-exit remains house style for the short commands, while
// `mcp` is legitimately long-running. What keeps a suspended (or sync)
// command from booting the server underneath itself is the isCliEngaged()
// gate below, not the exit style.
// biome-ignore-all assist/source/organizeImports: entry prelude must evaluate first — see comment
import "./cli-bootstrap.js";
import { resolve } from "node:path";
import { getHarness, setPluginDataDir } from "@internal/pane-runtime";
import { ensureSystemUser } from "@/auth/system-user.js";
import { setAuthPolicyDb } from "@/auth.js";
import { isCliEngaged } from "@/cli.js";
import {
  APP_BASE_URL,
  assertProdAuthSecret,
  DATABASE_PATH,
  HOST,
  SERVER_PORT,
  SUBSHELL_LOG_RETENTION_DAYS,
  SUBSHELL_SERVER_DATA_DIR,
} from "@/constants.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { startServer } from "@/server.js";
import { loadAndApplyDebugLogging } from "@/services/logging-preference.js";
import { reconcileMaintenance } from "@/services/nodes/maintenance.js";
import { setNodeLifecycleHooks } from "@/services/nodes/node-events.js";
import { listOnline } from "@/services/nodes/node-registry.js";
import { prepareNetworkGuards, prepareNetworkProcesses } from "@/services/network/prepare.js";
import { stopAllProcesses } from "@/services/network/supervisor.js";
import { prepareLocalPlugins } from "@/services/nodes/local-plugins.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { completeUpdate, readPending, recordFailure, revertUpdate } from "@/services/update-transaction.js";
import { getNotifyService } from "@/services/notify.service.js";
import { sweepExpiredPaneLogs, tightenPaneLogModes } from "@/services/pane-log-hygiene.js";
import { createIdleWatcher, IDLE_TICK_MS } from "@/services/notify-idle.js";
import { hasAnyUser } from "@/services/registration-gate.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { BANNER_GROUP, getLogger } from "@/utils/logger.js";
import { banner } from "@/banner.js";
import { SERVER_VERSION } from "@/version.js";
import { sweepWsTokens } from "@/ws/ws-token.js";

export type { App } from "@/server.js";

// Plan 2 CLI gate: `isCliEngaged()` flips synchronously inside the prelude's
// `dispatchCli` call the moment a subcommand is recognised, so an async CLI
// command that yields mid-run can never have the server boot underneath it.
// The short commands exit synchronously before this body runs at all; `mcp`
// (spec 2026-09-03) DOES reach this body while its stdio loop runs — the gate
// is exactly what keeps that from booting the server around it.
const bootRequested = !isCliEngaged();

// Fail before ANYTHING (imports' side effects have run, but no DB write, no
// listener, no handler wiring): a production boot with the placeholder
// BETTER_AUTH_SECRET would sign cookies with a publicly known key. Thrown at
// module top level (not inside the boot IIFE) so the error reaches stderr as
// a real crash rather than an unhandled rejection whose console output can
// be lost to process.exit's truncation. Skipped for CLI invocations: `status`
// REPORTS a missing/placeholder secret, it must not die on one.
if (bootRequested) assertProdAuthSecret();

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

if (bootRequested) void bootServer();

async function bootServer(): Promise<void> {
  // Decoration, and deliberately separate from the version line below: the
  // banner rides its own transport (no timestamp/level prefix, or the wordmark
  // would be sheared at the top) and carries no fact, so anything filtering
  // logs loses nothing by dropping it.
  //
  // The blank lines are PADDING, added here rather than baked into the art:
  // `banner()` returns the wordmark and nothing else, so it stays reusable and
  // its tests can assert on the drawing alone. Boot output is what needs the
  // breathing room — butted straight against a timestamped log line, the mark
  // reads as part of the log rather than as a header.
  getLogger().withGroup(BANNER_GROUP).info(`\n${banner()}\n`);

  // FIRST line in the journal, before anything can fail: after a restart,
  // "which build came up?" is what decides how to read every line beneath it.
  // The service manager restarts whatever binary sits at the unit's ExecStart
  // path, so the answer is NOT always the one whoever is reading the log
  // assumes — an interrupted deploy, a binary scp'd over, a rolled-back
  // release. Same string `version` and `status` print: one fact, one spelling.
  getLogger().info(`subshell-server ${SERVER_VERSION}`);

  // Name the database before the first write touches it: a migration or
  // seeding failure is undiagnosable if the log never says which file was
  // opened (the path is config-driven — `DATABASE_PATH`, default
  // ./data/subshell.db — and relative to wherever the process was started).
  getLogger().info(`database: ${resolve(DATABASE_PATH)}`);

  // An update in flight (spec 2026-09-15 §4.3). Read BEFORE the migrations,
  // because the migrations are the thing it is a transaction over.
  const pending = readPending();
  if (pending && pending.to !== SERVER_VERSION) {
    // The binary that was meant to boot did not: something put an older one
    // back (the CLI's own rollback, or a hand). The swap is already undone —
    // what is missing is the RECORD, and without it the marker would refuse
    // every later update forever.
    recordFailure(pending, `expected ${pending.to} to boot, ${SERVER_VERSION} did`);
  }

  // DB + auth tables before the HTTP listener starts.
  try {
    await runMigrations();
    await runAuthMigrations();
  } catch (error) {
    if (pending && pending.to === SERVER_VERSION) {
      // This IS the new binary and it cannot migrate. Put the database and the
      // previous binary back and exit: the service manager respawns the old
      // version onto the restored database, which is the only state it can
      // boot in (kysely refuses a database carrying migrations it does not
      // know — measured, §12.3).
      revertUpdate(pending, error, {});
      process.exit(1);
    }
    throw error;
  }
  setAuthPolicyDb(db);
  // The debug-logging setting, as early as the database allows. Everything
  // before this line is written at `info` whatever the setting says, which is
  // why `SUBSHELL_DEBUG_LOGGING` exists for a boot nobody can reach a page on.
  await loadAndApplyDebugLogging();
  // Service user that owns admin-managed system keys; idempotent.
  await ensureSystemUser();
  // Seed/repair the control-plane host's `local` node row + Everyone/edit
  // share (spec 2026-08-31 §2). Idempotent; needs the system user seeded above.
  await ensureLocalNode(db);
  // This host's own plugins directory, prepared exactly like an agent's and
  // mirrored into the `local` row it just ensured. Best-effort: a plugin
  // directory that cannot be prepared must not be why a serviceable instance
  // refuses to boot — the next start retries.
  //
  // Seeding can add a built-in this instance has never had (the plugins-seed
  // record), so this runs before anything reads what the host offers.
  //
  // The data dir has to be named BEFORE any plugin code runs: a plugin host
  // built without one has no secret store and no state directory, and a
  // network plugin asked whether it holds a credential would be told no
  // forever. `plugin-host.ts` defaults rather than refusing, so this is the
  // one call that makes the default right for this process.
  setPluginDataDir(SUBSHELL_SERVER_DATA_DIR);
  try {
    await prepareLocalPlugins();
  } catch (err) {
    getLogger().withError(err).warn("could not prepare this host's plugins at boot; will retry next start");
  }

  // Network guards go in BEFORE the listener (spec 2026-09-15 network
  // plugins): a tunnel that survived this restart is already resolvable, so
  // the first request over it can arrive in the same millisecond the port
  // opens, and a guard installed after that is a guard that missed requests.
  try {
    await prepareNetworkGuards();
  } catch (err) {
    getLogger().withError(err).warn("could not install network request guards at boot");
  }

  // Children of this process, so nothing else reaps them: an exit that left
  // them running would leave a tunnel pointing at a port about to stop
  // answering. Registered before the listener for the same reason the stop
  // exists at all — the window in which a signal can arrive starts now.
  installShutdownHandlers();

  await startServer({ port: SERVER_PORT, host: HOST });

  // ...and the processes AFTER it. A tunnel proxies to this port, so starting
  // one before the server answers publishes a machine that returns connection
  // refused — worse than being briefly absent, because it is briefly WRONG.
  // This is also where a `SERVER_PORT` an admin changed while the server was
  // down is reconciled, which is the one thing the (memoryless) plugin cannot
  // notice for itself.
  try {
    await prepareNetworkProcesses();
  } catch (err) {
    getLogger().withError(err).warn("could not start network plugin processes at boot");
  }

  // The transaction completes only once this version is SERVING: migrations
  // passing is necessary and not sufficient — a binary that migrates and then
  // cannot bind is not an update that worked. Audited with actor null (the
  // booting process holds no session); an API-driven update audited its START
  // with the admin as actor, so the pair reads as "who asked" and "what
  // happened". Best-effort: an audit that fails must not undo an update that
  // succeeded, which is why `audit()` never throws.
  if (pending && pending.to === SERVER_VERSION) await completeUpdate(pending);

  // The handoff, said where a headless operator is standing (spec 2026-09-15
  // §4.3). `/api/setup/*` is public until the first account exists, and
  // nothing ever told anyone to go and use it: a CLI-provisioned server that
  // is working perfectly looked exactly like one that is broken. Printed
  // AFTER the listening lines so the address above and the URL here read as
  // one instruction, and only while it is true — the count is the same
  // `hasAnyUser` truth `GET /api/setup/status` and the registration gate
  // answer with, so this line and the wizard cannot disagree. Best-effort: a
  // count that fails is not a reason to refuse a boot that has already
  // succeeded.
  try {
    if (!(await hasAnyUser(db))) {
      getLogger().info(`No account yet. Open ${APP_BASE_URL}/setup to create the admin account.`);
    }
  } catch (err) {
    getLogger().withError(err).warn("could not check whether an admin account exists");
  }

  // Background housekeeping: expire WS attach tokens, reconcile tmux state.
  const subshells = new SubshellsRepository(db);
  const nodes = new NodesRepository(db);
  const manager = new SubshellManagerService({
    subshells,
    presets: new PresetsRepository(db),
  });
  // Node lifecycle events (spec §3.3/§6.3): the sweep's manager instance is
  // the hook host, so `exit` events and the reconnect `subshells_report`
  // census converge through the SAME death/revive transitions (and the same
  // in-process restart lease) as the periodic sweep. Without this the frames
  // warn-and-drop.
  setNodeLifecycleHooks({
    onExit: (nodeId, subshellId, exitCode, at) => manager.applyRemoteExit(nodeId, subshellId, exitCode, at),
    onSubshellsReport: (nodeId, report) => manager.applySubshellsReport(nodeId, report),
    // Maintenance is a node-level act rather than a subshell one, so it does
    // not route through the manager: the hook hands the machine's own copy to
    // the one module that reconciles the two (spec 2026-09-14 §5.2).
    onMaintenance: (nodeId, reported) => reconcileMaintenance(nodeId, reported),
  });
  // Restore alive/exit state at boot: a backend restart mid-subshell must not
  // leave stale alive=1 rows (tmux subshells died with the old process).
  await manager.reconcileAll();

  // Pane logs hold the verbatim transcript of every session, typed secrets
  // included. New ones are created 0600 by the pipe-pane umask, but logs
  // written before that fix are 0644 on disk and nothing else revisits them —
  // so the repair runs at every boot (idempotent, cheap).
  tightenPaneLogModes();
  // ...and they no longer live forever. Hourly rather than on the 60s sweep:
  // a retention window measured in days gains nothing from a fast tick, and
  // this one walks the directory.
  const sweepPaneLogs = async (): Promise<void> => {
    const running = await subshells.listRunning();
    sweepExpiredPaneLogs({
      retentionDays: SUBSHELL_LOG_RETENTION_DAYS,
      runningIds: new Set(running.map((row) => row.id)),
    });
  };
  await sweepPaneLogs();
  setInterval(() => {
    void sweepPaneLogs().catch((err: unknown) => getLogger().withError(err).warn("pane log sweep failed"));
  }, 3_600_000);
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
  // without native attention hooks (opencode/hermes/pi) a subshell log that
  // stops growing means the turn is done → push + "waiting for you" stamp.
  // Hooked harnesses (claude-code) ring via their hooks; the watcher only
  // clears their waiting state on renewed output. Ticks start one
  // IDLE_TICK_MS after boot (setInterval never fires immediately); subshells
  // that were already idle never ring because the watcher seeds an
  // already-quiet log as fired — only new output re-arms it.
  const idleWatcher = createIdleWatcher({
    listRows: () => subshells.listRunning(),
    statMtimeMs: async (id) => {
      try {
        return (await Bun.file(subshellLogPath(id)).stat()).mtime.getTime();
      } catch {
        return null; // no log yet — nothing to measure
      }
    },
    harnessHasHooks: (harnessId) => getHarness(harnessId)?.supportsAttentionHooks === true,
    notifySubshell: async (id, kind) => {
      await getNotifyService().notifySubshell(id, kind);
    },
    setWaiting: async (id) => {
      await subshells.update(id, { waitingSince: new Date().toISOString() });
    },
    clearWaiting: async (id) => {
      await subshells.update(id, { waitingSince: null });
    },
  });
  setInterval(() => {
    void idleWatcher.tick(Date.now());
  }, IDLE_TICK_MS);
}

/**
 * Stops the supervised network children on the way out.
 *
 * `performRestart` does the same thing on the restart path; this covers the
 * other two ways this process ends — a service manager's SIGTERM and a
 * developer's Ctrl-C. Registering a handler for either REPLACES the default
 * (which is to die), so both branches exit explicitly, and a second signal is
 * ignored rather than starting a second teardown.
 *
 * The deadline is not paranoia about our own code — `disarmProcess` is bounded
 * by its own SIGTERM grace — but about a child that ignores both signals while
 * systemd's `TimeoutStopSec` runs down. Exiting late looks like a hung server;
 * exiting is what the operator asked for.
 */
function installShutdownHandlers(): void {
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    getLogger().info(`received ${signal}; stopping supervised network processes`);
    const deadline = setTimeout(() => process.exit(0), 10_000);
    // Never blocks the exit on an unref'd timer of its own.
    deadline.unref?.();
    void stopAllProcesses()
      .catch((err: unknown) => getLogger().withError(err).warn("could not stop every network process cleanly"))
      .finally(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
