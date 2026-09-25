/**
 * `subshell-server update` — install a newer server over this one, reversibly
 * (spec 2026-09-15 §4.4).
 *
 * The whole verb is ten steps and nine of them are refusals: what makes an
 * update safe is almost entirely what it declines to do. The one irreversible
 * moment is the swap in step 7 — keep the running binary as `.previous`,
 * then one rename onto the live path, which never moves it out from under
 * the unit (round-3 sweep C5) — and even that is undone by the NEXT boot
 * rather than by this process; see `services/update-transaction.ts` for why
 * the transaction has to be shaped that way.
 *
 * **It is ASYNC, and that is the third named exception to the sync-exit house
 * style** (`cli.ts`'s header; `apps/server/api/AGENTS.md` lists it beside `init`
 * and `configure`). It downloads and it prompts, neither of which a
 * `readSync(0, …)` command can do. Safe for the same reason those two are:
 * the entry graph is IO-free at import and `isCliEngaged()` flipped
 * synchronously before this ever ran, so no boot can start underneath it.
 *
 * What it deliberately does NOT do: write a path by convention. The binary it
 * replaces is the one the service definition NAMES
 * (`services/installed-binary.ts`), or nothing — a `~/.local/bin` write on a
 * host whose unit points elsewhere is an update that reports success and
 * changes nothing.
 */
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostReleaseTarget, releaseAssetNames, semverLt } from "@internal/subshell-protocol";
import { type CliResult, controlService, queryService, type ServiceDeps } from "@/service.js";
import { backupDatabase, restoreDatabase } from "@/services/db-backup.js";
import { binaryIsReplaceable, type InstalledBinary, resolveInstalledBinary } from "@/services/installed-binary.js";
import {
  downloadVerified,
  installableCliRelease,
  type ResolvedRelease,
  refreshReleases,
  releaseSourceUrl,
  signedAssetDigest,
} from "@/services/releases.js";
import {
  beginUpdate,
  clearPending,
  keepPreviousBinary,
  type PendingUpdate,
  readFailed,
  readPending,
} from "@/services/update-transaction.js";
import { SERVER_VERSION } from "@/version.js";

/** Everything the `update` verb accepts. */
export interface UpdateOpts {
  /** Report what is available and stop. */
  check?: boolean;
  /** Install this published version rather than the newest. */
  to?: string;
  /** Install this local file instead of a release (the desktop apps' path). */
  from?: string;
  /** Override the downgrade refusal and the pane-safety restart refusal. */
  force?: boolean;
  /** Skip the confirmation. */
  yes?: boolean;
  /** Machine-readable output. */
  json?: boolean;
  /** Swap the binary and stop — the caller owns the restart (the desktop apps). */
  noRestart?: boolean;
  /** Undo the last update instead of installing one. */
  rollback?: boolean;
}

/** Injected seams, so the whole verb is testable without a network or a service manager. */
export interface UpdateDeps {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Yes/no prompt; `null` = cancelled. */
  confirm: (question: string, def: boolean) => boolean | null | Promise<boolean | null>;
  /** Whether stdin is a TTY — a non-TTY takes the default, as `init` does. */
  isTTY: boolean;
  /** The service seams, for the state read and the restart. */
  service: ServiceDeps;
  /** Which binary an update would replace (default: the real ladder). */
  installed?: () => InstalledBinary;
  /** Run `<file> version` and return its stdout (default: a bounded spawn). */
  probeVersion?: (file: string) => string | null;
  /**
   * Snapshot the database (default: {@link backupDatabase} over the configured
   * one). Injected only by tests: this suite runs in ONE process against ONE
   * database, and a test that really snapshotted and restored it would take
   * every other test file with it.
   */
  backup?: () => Promise<{ path: string } | null>;
  /** Put a snapshot back (default: {@link restoreDatabase}). Injected for the same reason. */
  restore?: (backupPath: string) => void;
  /** Sleep, for the marker wait (default: `Bun.sleep`). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock, for the marker wait's deadline (default: `Date.now`). */
  now?: () => number;
}

/** How long to wait for the restarted binary to finish or revert the transaction. */
export const UPDATE_WAIT_MS = 60_000;
const WAIT_POLL_MS = 500;

/** The version out of a `subshell-server X.Y.Z` line — the byte-identical machine contract. */
export function parseServerVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^subshell-server (\d+\.\d+\.\d+)$/m);
  return match?.[1] ?? null;
}

/** Bounded `<file> version`, the same probe the desktop ladders run. */
function defaultProbeVersion(file: string): string | null {
  try {
    const res = Bun.spawnSync({ cmd: [file, "version"], stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    return res.exitCode === 0 ? parseServerVersion(res.stdout.toString()) : null;
  } catch {
    return null;
  }
}

/**
 * Run the verb.
 *
 * @returns the process exit code — 0 for a completed (or already-current)
 *   update, 1 for every refusal and every failure
 */
export async function runUpdate(opts: UpdateOpts, deps: UpdateDeps): Promise<number> {
  return opts.rollback ? runRollback(opts, deps) : runInstall(opts, deps);
}

/** Step 1: where the installed binary is, and whether it can be replaced. */
function locate(deps: UpdateDeps): { path: string; dir: string } | { refusal: string } {
  const installed = (deps.installed ?? (() => resolveInstalledBinary({ configDir: deps.service.configDir })))();
  if (installed.kind === "source") {
    return { refusal: `${installed.reason} (${installed.argv.join(" ")})` };
  }
  if (installed.kind === "unknown") return { refusal: installed.reason };
  const replaceable = binaryIsReplaceable(installed.path);
  if (!replaceable.ok) return { refusal: `cannot replace ${installed.path}: ${replaceable.reason}` };
  return { path: installed.path, dir: dirname(installed.path) };
}

/** Step 2, release half: the published release to install, or a refusal. */
async function pickRelease(opts: UpdateOpts): Promise<{ release: ResolvedRelease } | { refusal: string }> {
  if (releaseSourceUrl() === null) {
    return { refusal: "this host does not fetch releases (SUBSHELL_RELEASE_URL is empty); use --from <file>" };
  }
  try {
    // `--check` and an explicit `--to` both want the CURRENT list rather than
    // a 15-minute-old memo: one is the person asking, and the other names a
    // tag they may have just seen published.
    if (opts.check || opts.to) await refreshReleases();
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
  // The SIGNED-MANIFEST gate, one implementation with the dashboard's Server
  // row and the update POST (spec 2026-09-17 §5 path 4): no manifest, an
  // unsigned manifest and a failed signature each refuse with their own
  // sentence — the release that fails verification is not merely older, it
  // does not exist to this host.
  const gate = await installableCliRelease("cli-server");
  if (!gate.ok) return { refusal: gate.reason };
  const newest = gate.release;
  if (opts.to !== undefined && opts.to !== newest.version) {
    // Only the NEWEST release of a component is indexed, so a `--to` naming an
    // older one has nothing to resolve. Say which one is available rather than
    // "not found", which reads as a broken source.
    return { refusal: `the release source's newest server release is ${newest.version}, not ${opts.to}` };
  }
  return { release: newest };
}

/** The whole of `--check`, as data, so both renderings say the same thing. */
export interface UpdateCheck {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Why `latest` is null; absent when it is not. */
  reason?: string;
}

async function runInstall(opts: UpdateOpts, deps: UpdateDeps): Promise<number> {
  const { log, error } = deps;

  // 1. Where is the installed binary.
  const located = locate(deps);
  if ("refusal" in located) {
    error(`subshell-server: ${located.refusal}`);
    return 1;
  }
  const { path: binary, dir: binaryDir } = located;

  // 2. What to install.
  let target: { version: string; install: () => Promise<string> };
  if (opts.from !== undefined) {
    const from = opts.from;
    if (!existsSync(from)) {
      error(`subshell-server: ${from} is not there`);
      return 1;
    }
    // A local file the operator or the desktop app chose: there is no digest
    // to check, so the only evidence of what it is is what it SAYS it is —
    // and a file that cannot answer `version` does not get installed.
    const version = (deps.probeVersion ?? defaultProbeVersion)(from);
    if (version === null) {
      error(`subshell-server: ${from} did not answer \`subshell-server X.Y.Z\` to \`version\``);
      return 1;
    }
    target = {
      version,
      install: async () => {
        const tmp = join(binaryDir, `${basename(binary)}.download-${process.pid}`);
        await Bun.write(tmp, Bun.file(from));
        return tmp;
      },
    };
  } else {
    const picked = await pickRelease(opts);
    if ("refusal" in picked) {
      if (opts.check && opts.json) {
        log(
          JSON.stringify({ installed: SERVER_VERSION, latest: null, updateAvailable: false, reason: picked.refusal }),
        );
        return 0;
      }
      error(`subshell-server: ${picked.refusal}`);
      return 1;
    }
    const release = picked.release;
    const hostTarget = hostReleaseTarget(process.platform, process.arch);
    if (hostTarget === null) {
      error(`subshell-server: no server binary is published for ${process.platform}-${process.arch}`);
      return 1;
    }
    const names = releaseAssetNames("cli-server", hostTarget);
    const url = release.assets.get(names.binary);
    if (url === undefined) {
      error(`subshell-server: ${release.tag} publishes no ${names.binary}`);
      return 1;
    }
    target = {
      version: release.version,
      install: async () => {
        // The digest from the VERIFIED signed manifest (spec 2026-09-17 §5
        // path 2) — pickRelease only returned this release because its
        // signature checked out, and `signedAssetDigest` re-reads the memoized
        // outcome rather than a `.sha256` the same host also served.
        const expectedDigest = await signedAssetDigest(release, names.binary);
        log(`Downloading ${release.version}…`);
        return downloadVerified({
          url,
          expectedDigest,
          destDir: binaryDir,
          destName: basename(binary),
          onProgress: () => {},
        });
      },
    };
  }

  // 3. Compare.
  const check: UpdateCheck = {
    installed: SERVER_VERSION,
    latest: target.version,
    updateAvailable: semverLt(SERVER_VERSION, target.version),
  };
  if (opts.check) {
    if (opts.json) log(JSON.stringify(check));
    else if (check.updateAvailable) log(`${target.version} is available. Running ${SERVER_VERSION}.`);
    else log(`Running ${SERVER_VERSION}, the newest release.`);
    return 0;
  }
  if (target.version === SERVER_VERSION) {
    log(`Already at ${SERVER_VERSION}.`);
    return 0;
  }
  if (semverLt(target.version, SERVER_VERSION) && opts.force !== true) {
    error(
      `subshell-server: ${target.version} is older than the running ${SERVER_VERSION}; pass --force to install it anyway`,
    );
    return 1;
  }

  const state = queryService(deps.service);
  const willRestart = opts.noRestart !== true && state.installed && state.state === "running";
  const lethal = state.paneSafety !== "keeps";

  // 4. Confirm.
  if (opts.yes !== true) {
    const lines = [
      `Update ${SERVER_VERSION} → ${target.version}?`,
      `  binary:   ${binary}`,
      `  database: backed up first`,
      willRestart
        ? lethal
          ? "  restart:  YES, and this service definition CLOSES every running subshell"
          : "  restart:  yes; open subshells keep running"
        : "  restart:  no. Start it yourself afterwards",
    ];
    for (const line of lines) log(line);
    const answer = deps.isTTY ? await deps.confirm("Install it?", true) : true;
    if (answer !== true) {
      log("Stopped.");
      return answer === null ? 1 : 0;
    }
  }
  if (willRestart && lethal && opts.force !== true) {
    error("subshell-server: refusing to restart: this service definition would close every running subshell; --force");
    return 1;
  }

  // 5. Download and probe.
  let tmp: string;
  try {
    tmp = await target.install();
  } catch (err) {
    error(`subshell-server: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  chmodSync(tmp, 0o755);
  const actual = (deps.probeVersion ?? defaultProbeVersion)(tmp);
  if (actual !== target.version) {
    // A binary that cannot say what it is does not get installed, and neither
    // does one that says something else: the digest proves the bytes are the
    // ones that release published, not that the release was labelled right.
    rmSync(tmp, { force: true });
    error(`subshell-server: the downloaded binary reports ${actual ?? "nothing"}, not ${target.version}`);
    return 1;
  }

  // 6. Back up.
  let backup: string | null = null;
  try {
    const written = await (deps.backup ?? (() => backupDatabase({ reason: "update", version: SERVER_VERSION })))();
    backup = written?.path ?? null;
    log(written === null ? "No database yet; nothing to back up." : `Backed up the database to ${written.path}.`);
  } catch (err) {
    rmSync(tmp, { force: true });
    error(`subshell-server: could not back up the database: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 7. The transaction.
  const previousBinary = `${binary}.previous`;
  const pending: PendingUpdate = {
    from: SERVER_VERSION,
    to: target.version,
    binary,
    previousBinary,
    backup,
    startedAt: new Date().toISOString(),
    origin: "cli",
    forced: opts.force === true,
  };
  try {
    beginUpdate(pending);
  } catch (err) {
    rmSync(tmp, { force: true });
    error(`subshell-server: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  // 7. The swap: keep the RUNNING binary as `.previous` first, then ONE
  //    rename onto the live path (measured safe over a running image, spec
  //    §12.2). The old shape — rename aside, rename in — left a window where
  //    the path the unit names held nothing, and a kill or power loss inside
  //    it meant a hand at a keyboard on a deliberately headless machine.
  //    A crash HERE, after the copy and before the rename, leaves the old
  //    binary at ExecStart: bootable, and its boot records the failed
  //    marker. (`update --rollback` reads exactly this `.previous` — the
  //    contract is unchanged, the path it travels is not.)
  try {
    keepPreviousBinary(binary);
  } catch (err) {
    clearPending();
    rmSync(tmp, { force: true });
    error(
      `subshell-server: could not keep a rollback copy of ${binary}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  try {
    renameSync(tmp, binary);
  } catch (err) {
    // The live path was never moved — the old binary is still exactly where
    // the service definition points it. Undo the marker and the copy, and
    // the host stands where it started.
    rmSync(previousBinary, { force: true });
    clearPending();
    rmSync(tmp, { force: true });
    error(`subshell-server: could not install ${binary}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  log(`Installed ${target.version} at ${binary}.`);

  // 8. Restart.
  if (opts.noRestart === true) {
    log("Not restarting (--no-restart). The update completes at the next start.");
    return jsonTail(opts, deps, { from: SERVER_VERSION, to: target.version, restarted: false, backup });
  }
  if (!state.installed) {
    log("No service is installed; start the new binary yourself to complete the update.");
    return jsonTail(opts, deps, { from: SERVER_VERSION, to: target.version, restarted: false, backup });
  }
  if (state.state !== "running") {
    log("The service is not running; start it with `subshell-server service start` to complete the update.");
    return jsonTail(opts, deps, { from: SERVER_VERSION, to: target.version, restarted: false, backup });
  }
  const restart: CliResult = controlService(deps.service, "restart", { force: opts.force === true });
  if (restart.out !== "") log(restart.out.replace(/\n+$/, ""));
  if (restart.code !== 0) {
    if (restart.err !== "") deps.error(restart.err.replace(/\n+$/, ""));
    deps.error("subshell-server: the binary was installed but the restart failed; run `update --rollback` to undo it");
    return 1;
  }

  // 9. Wait for the new binary's boot to finish or revert the transaction.
  return waitForMarker(opts, deps, target.version, backup);
}

/** Success/failure output shared by the restart and no-restart tails. */
function jsonTail(
  opts: UpdateOpts,
  deps: UpdateDeps,
  result: { from: string; to: string; restarted: boolean; backup: string | null },
): number {
  if (opts.json) deps.log(JSON.stringify(result));
  return 0;
}

/**
 * Poll the marker directory for up to {@link UPDATE_WAIT_MS}.
 *
 * `pending.json` gone means the new binary booted, migrated, listened and
 * audited. `failed.json` present means it reverted and the previous version is
 * back. NEITHER means the binary never booted at all — a crash before the hook,
 * a service manager that gave up — and in that case this process performs the
 * rollback itself, because nothing else is going to.
 */
async function waitForMarker(opts: UpdateOpts, deps: UpdateDeps, to: string, backup: string | null): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + UPDATE_WAIT_MS;
  while (now() < deadline) {
    const failed = readFailed();
    if (failed !== null && failed.to === to) {
      deps.error(`subshell-server: the update to ${to} failed and ${failed.from} was restored: ${failed.error}`);
      if (opts.json) deps.log(JSON.stringify({ ok: false, from: failed.from, to, error: failed.error }));
      return 1;
    }
    if (readPending() === null) {
      deps.log(`Updated to ${to}.`);
      return jsonTail(opts, deps, { from: SERVER_VERSION, to, restarted: true, backup });
    }
    await sleep(WAIT_POLL_MS);
  }
  deps.error(`subshell-server: ${to} did not come up within ${UPDATE_WAIT_MS / 1000}s; rolling back`);
  const code = await runRollback({ yes: true, json: opts.json }, deps);
  return code === 0 ? 1 : code;
}

/**
 * `--rollback`: put the previous binary and its database back, by hand.
 *
 * The same act `revertUpdate` performs at boot, driven from outside — for the
 * case the boot hook cannot cover, which is a new binary that never booted at
 * all. It reads the marker rather than guessing: the backup path lives there
 * and nowhere else.
 */
async function runRollback(opts: UpdateOpts, deps: UpdateDeps): Promise<number> {
  const { log, error } = deps;
  const located = locate(deps);
  if ("refusal" in located) {
    error(`subshell-server: ${located.refusal}`);
    return 1;
  }
  const binary = located.path;
  const previousBinary = `${binary}.previous`;
  if (!existsSync(previousBinary)) {
    error(`subshell-server: there is nothing to roll back to (${previousBinary} is not there)`);
    return 1;
  }
  // A `.previous` that cannot run is not a rollback target (round-3 review,
  // finding 2). `rename(2)` below is unconditional — whatever lands at the
  // path the unit names is what the service manager tries to EXEC, and a
  // truncated copy (the shape an interrupted copy-fallback left before the
  // copy became atomic, or one a hand produced since) buys a crash loop with
  // no journal line. So ask the copy the question every other install path
  // asks a candidate — `version`, exit 0 — BEFORE confirming, stopping the
  // service, restoring a database, or moving a byte. The refusal names the
  // file; the running binary and the marker stay exactly where they are.
  if ((deps.probeVersion ?? defaultProbeVersion)(previousBinary) === null) {
    error(
      `subshell-server: ${previousBinary} did not answer \`version\`, so it cannot be installed back; the running ${SERVER_VERSION} was left in place. Install a fresh binary by hand (\`update --from <file>\`)`,
    );
    return 1;
  }
  const marker = readPending() ?? readFailed();
  const backup = marker?.backup ?? null;

  if (opts.yes !== true) {
    log(`Roll back to ${marker?.from ?? "the previous binary"}?`);
    log(`  binary:   ${previousBinary} → ${binary}`);
    log(backup === null ? "  database: unchanged (no backup was taken)" : `  database: restored from ${backup}`);
    const answer = deps.isTTY ? await deps.confirm("Roll it back?", false) : true;
    if (answer !== true) {
      log("Stopped.");
      return answer === null ? 1 : 0;
    }
  }

  // Stop first: restoring a database under a live handle leaves that handle
  // holding a deleted inode.
  const state = queryService(deps.service);
  const wasRunning = state.installed && state.state === "running";
  if (wasRunning) {
    const stop = controlService(deps.service, "stop", { force: opts.force === true });
    if (stop.code !== 0) {
      error(stop.err.replace(/\n+$/, "") || "subshell-server: could not stop the service");
      return 1;
    }
  }

  if (backup !== null) {
    try {
      (deps.restore ?? restoreDatabase)(backup);
      log(`Restored the database from ${backup}.`);
    } catch (err) {
      error(`subshell-server: could not restore ${backup}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  renameSync(previousBinary, binary);
  clearPending();
  log(`Rolled ${binary} back to ${marker?.from ?? "the previous binary"}.`);

  if (wasRunning) {
    const start = controlService(deps.service, "start");
    if (start.out !== "") log(start.out.replace(/\n+$/, ""));
    if (start.code !== 0) {
      error(start.err.replace(/\n+$/, ""));
      return 1;
    }
  }
  if (opts.json) log(JSON.stringify({ ok: true, rolledBackTo: marker?.from ?? null, restored: backup }));
  return 0;
}
