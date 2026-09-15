/**
 * The dashboard's half of `subshell-server update` (spec 2026-09-15 §4.5): one
 * READ that says whether this server can update itself, and one in-process JOB
 * that performs the same swap the CLI performs.
 *
 * **It is the CLI's steps 5–7 and then `performRestart()`.** `commands/update.ts`
 * owns the ten-step verb, and nine of those steps are refusals an HTTP route
 * expresses as 409s instead — so what is shared is the irreversible middle:
 * download-and-verify, chmod, probe, back up, `beginUpdate`, two renames. The
 * tail differs for one structural reason: the CLI asks the service manager to
 * restart a process it is not, while this code IS the process, so it exits the
 * way `POST /api/admin/server/restart` does and lets the manager respawn it.
 * Everything after that — finishing or reverting the transaction — belongs to
 * the next boot either way (`services/update-transaction.ts`).
 *
 * **The job is a module-level singleton and deliberately not a queue.** There
 * is exactly one binary to replace on this host, so a second concurrent start
 * is a mistake rather than work to schedule: the route refuses it with
 * `UPDATE_IN_PROGRESS`, and `beginUpdate` refuses it again from the marker on
 * disk, which is what also covers a CLI update started in a terminal.
 *
 * **A failed job stays visible until the next start.** It is the only record
 * of a failure BEFORE the swap — a failure after it writes `failed.json` at
 * the next boot instead — and a page that cleared it on read would leave a
 * download that 404'd looking like a button that did nothing.
 */
import { chmodSync, renameSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { hostReleaseTarget, releaseAssetNames, semverLt } from "@internal/subshell-protocol";
import { serverConfigDir } from "@/config-env.js";
import { SUBSHELL_DB_BACKUPS_KEEP } from "@/constants.js";
import { type BackupFile, backupDatabase, backupsDir, listBackups } from "@/services/db-backup.js";
import { binaryIsReplaceable, type InstalledBinary, resolveInstalledBinary } from "@/services/installed-binary.js";
import {
  downloadVerified,
  type ReleaseIndex,
  type ResolvedRelease,
  readDigest,
  refreshReleases,
  releasePublishedAt,
  releaseSourceUrl,
  resolveReleases,
} from "@/services/releases.js";
import { collectDeployment, collectDeploymentCached, type DeploymentView } from "@/services/server-deployment.js";
import { performRestart } from "@/services/server-restart.js";
import {
  beginUpdate,
  clearPending,
  type FailedUpdate,
  readFailed,
  readPending,
} from "@/services/update-transaction.js";
import { getLogger } from "@/utils/logger.js";
import { SERVER_VERSION } from "@/version.js";

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/** Which step of an update is running. `failed` is terminal and survives until the next start. */
export type UpdateJobPhase = "downloading" | "verifying" | "backing-up" | "swapping" | "restarting" | "failed";

/**
 * Where a running update has got to.
 *
 * One flat shape rather than a discriminated union, because it is polled once
 * a second and rendered as ONE line: a union would make every reader narrow
 * before it could print a phase name, and the two payload fields (`received`
 * and `error`) belong to exactly one phase each and are null everywhere else.
 */
export interface UpdateJob {
  /** The version that was installed when the job started. */
  from: string;
  /** The version being installed. */
  to: string;
  /** ISO 8601, when the job started. */
  startedAt: string;
  /** Which step is running now. */
  phase: UpdateJobPhase;
  /** Bytes downloaded so far; only moves while `phase` is `downloading`. */
  received: number;
  /** Total bytes, when the release source sent a length; null when it did not. */
  total: number | null;
  /** Why the job stopped, when `phase` is `failed`; null otherwise. */
  error: string | null;
}

let job: UpdateJob | null = null;

/** The running (or last failed) job, or null when none has started in this process. */
export function currentUpdateJob(): UpdateJob | null {
  return job;
}

/** Whether a job is in flight — anything that is not `failed`. */
export function updateJobRunning(): boolean {
  return job !== null && job.phase !== "failed";
}

/** Drop the job so a suite starts clean. @internal */
export function resetUpdateJobForTests(): void {
  job = null;
}

/** What {@link startServerUpdate} touches outside itself; every one injectable for tests. */
export interface ServerUpdateJobDeps {
  /** Snapshot the database (default: {@link backupDatabase} over the configured one). */
  backup?: () => Promise<{ path: string } | null>;
  /** Run `<file> version` and return the version it reports (default: a bounded spawn). */
  probeVersion?: (file: string) => string | null;
  /** Exit for the service manager (default: {@link performRestart}). */
  restart?: () => void;
  /** Make a downloaded file executable (default: `chmodSync 0755`). */
  chmod?: (path: string, mode: number) => void;
  /** Move a file (default: `renameSync`). */
  rename?: (from: string, to: string) => void;
  /** Remove a file (default: `rmSync … force`). */
  remove?: (path: string) => void;
}

/** The version out of a `subshell-server X.Y.Z` line — the byte-identical machine contract. */
function probeInstalledVersion(file: string): string | null {
  try {
    const res = Bun.spawnSync({ cmd: [file, "version"], stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    if (res.exitCode !== 0) return null;
    return (
      res.stdout
        .toString()
        .trim()
        .match(/^subshell-server (\d+\.\d+\.\d+)$/m)?.[1] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Start the in-process update. Returns immediately; the caller has already
 * answered 202 and the page polls {@link currentUpdateJob} through the view.
 *
 * Every refusal this could raise has already been evaluated by the route
 * (§4.5), so what is left here is the work and the failures only a running
 * download can produce: an asset that 404s, a digest that does not match, a
 * binary that reports the wrong version, a database that will not snapshot.
 * All of those land in `phase: "failed"` with the message, having deleted the
 * temp file and left this host running exactly what it was running before.
 */
export function startServerUpdate(
  input: { release: ResolvedRelease; binary: string; forced: boolean },
  deps: ServerUpdateJobDeps = {},
): void {
  job = {
    from: SERVER_VERSION,
    to: input.release.version,
    startedAt: new Date().toISOString(),
    phase: "downloading",
    received: 0,
    total: null,
    error: null,
  };
  void runJob(input, deps).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

/** Record the failure on the job and in the log. This path never leaves a marker on disk. */
function fail(message: string): void {
  if (job !== null) job = { ...job, phase: "failed", error: message };
  getLogger().error(`server update failed before the swap: ${message}`);
}

async function runJob(
  input: { release: ResolvedRelease; binary: string; forced: boolean },
  deps: ServerUpdateJobDeps,
): Promise<void> {
  const chmod = deps.chmod ?? ((path: string, mode: number) => chmodSync(path, mode));
  const rename = deps.rename ?? ((from: string, to: string) => renameSync(from, to));
  const remove = deps.remove ?? ((path: string) => rmSync(path, { force: true }));
  const { release, binary } = input;
  const binaryDir = dirname(binary);

  const hostTarget = hostReleaseTarget(process.platform, process.arch);
  if (hostTarget === null) {
    fail(`no server binary is published for ${process.platform}-${process.arch}`);
    return;
  }
  const names = releaseAssetNames("server", hostTarget);
  const url = release.assets.get(names.binary);
  if (url === undefined) {
    fail(`${release.tag} publishes no ${names.binary}`);
    return;
  }

  // 5. Download, hashing on the way past, then prove what arrived.
  let tmp: string;
  try {
    const expectedDigest = await readDigest(release, names.sidecar);
    tmp = await downloadVerified({
      url,
      expectedDigest,
      destDir: binaryDir,
      destName: basename(binary),
      onProgress: (received, total) => {
        if (job !== null && job.phase === "downloading") job = { ...job, received, total };
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (job !== null) job = { ...job, phase: "verifying" };
  try {
    chmod(tmp, 0o755);
  } catch (error) {
    remove(tmp);
    fail(`could not make ${tmp} executable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const reported = (deps.probeVersion ?? probeInstalledVersion)(tmp);
  if (reported !== release.version) {
    // The digest proves the bytes are the ones that release published; it does
    // NOT prove the release was labelled right. A binary that cannot say what
    // it is does not get installed, and neither does one that says something else.
    remove(tmp);
    fail(`the downloaded binary reports ${reported ?? "nothing"}, not ${release.version}`);
    return;
  }

  // 6. Back up. A fresh install with no database answers null, which is a
  //    state to report rather than fail on.
  if (job !== null) job = { ...job, phase: "backing-up" };
  let backup: string | null = null;
  try {
    const written = await (deps.backup ?? (() => backupDatabase({ reason: "update", version: SERVER_VERSION })))();
    backup = written?.path ?? null;
  } catch (error) {
    remove(tmp);
    fail(`could not back up the database: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // 7. The transaction. From `beginUpdate` to the second rename is the only
  //    stretch in which this host is not in the state it started in.
  if (job !== null) job = { ...job, phase: "swapping" };
  const previousBinary = `${binary}.previous`;
  try {
    beginUpdate({
      from: SERVER_VERSION,
      to: release.version,
      binary,
      previousBinary,
      backup,
      startedAt: new Date().toISOString(),
      origin: "api",
      forced: input.forced,
    });
  } catch (error) {
    remove(tmp);
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    rename(binary, previousBinary);
  } catch (error) {
    clearPending();
    remove(tmp);
    fail(`could not move ${binary} aside: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    rename(tmp, binary);
  } catch (error) {
    // Between the two renames is the only window where this host has no
    // binary at all. Put it back before answering anything else.
    try {
      rename(previousBinary, binary);
    } catch {
      // Both failed: the marker names `.previous` for a hand repair.
    }
    clearPending();
    remove(tmp);
    fail(`could not install ${binary}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // 8. Exit for the manager. The NEXT boot finishes or reverts the transaction.
  if (job !== null) job = { ...job, phase: "restarting" };
  getLogger().info(`server update ${SERVER_VERSION} → ${release.version}: installed, restarting`);
  (deps.restart ?? performRestart)();
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** One release, as a view names it. */
export interface ReleaseRef {
  /** Strict `X.Y.Z`, off the tag. */
  version: string;
  /** The git tag the release carries (`server-v0.7.0`). */
  tag: string;
  /** ISO 8601 from the release source, or null when it did not say. */
  publishedAt: string | null;
}

/** What `GET /api/admin/server/update` answers (spec §4.5). */
export interface ServerUpdateView {
  /** The release source, and whether it is on at all. */
  source: { url: string | null; enabled: boolean };
  /** The version this process is. */
  current: string;
  /** The newest published `server` release, or null. */
  latest: ReleaseRef | null;
  /** Why `latest` is null while the source is ON; null when the source answered (or is off). */
  latestError: string | null;
  /** Whether {@link latest} is newer than {@link current}. */
  updateAvailable: boolean;
  /** Whether an update could be applied at all right now, and every reason it could not. */
  canApply: { ok: boolean; reasons: string[] };
  /** Which file an update would replace. */
  binary: { kind: InstalledBinary["kind"]; path: string | null; reason: string | null };
  /** Whether a restart keeps live panes — the dialog's sentence and its forced path. */
  paneSafety: DeploymentView["service"]["paneSafety"];
  /** The running (or last failed) job in this process. */
  job: UpdateJob | null;
  /** The last update that reverted at boot, kept until the next `beginUpdate`. */
  lastFailure: FailedUpdate | null;
  /** Where snapshots go, how many are kept, and what is there. */
  backups: { dir: string; keep: number; count: number; latest: BackupFile | null };
}

/** The release index, or the reason it could not be read. Never throws. */
async function readIndex(refresh: boolean): Promise<{ index: ReleaseIndex | null; error: string | null }> {
  if (releaseSourceUrl() === null) return { index: null, error: null };
  try {
    return { index: refresh ? await refreshReleases() : await resolveReleases(), error: null };
  } catch (error) {
    // A page that cannot reach the release source still renders; it says so.
    return { index: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One resolved release as a {@link ReleaseRef}. */
export function releaseRef(release: ResolvedRelease | null): ReleaseRef | null {
  if (release === null) return null;
  return { version: release.version, tag: release.tag, publishedAt: releasePublishedAt(release.tag) };
}

/**
 * Everything the Updates page's Server card needs, in one read.
 *
 * `canApply.reasons` holds the HARD blockers — the refusals no press can
 * overcome — and deliberately not every 409 the POST can answer. Two are left
 * out on purpose: `UPDATE_NOT_AVAILABLE` is `updateAvailable: false`, which the
 * card renders as "the newest release" rather than as a failure; and
 * `RESTART_KILLS_PANES` is FORCIBLE, so listing it would disable the very
 * button whose dialog offers the forced path. `paneSafety` travels instead,
 * which is what the restart dialog reads for the same sentence.
 *
 * @param refresh - re-read the release source instead of trusting the 15-minute memo
 */
export async function collectServerUpdateView(refresh = false): Promise<ServerUpdateView> {
  const url = releaseSourceUrl();
  const { index, error: latestError } = await readIndex(refresh);
  const latest = releaseRef(index?.byComponent.server ?? null);
  // The uncached collector only where someone pressed something: collecting
  // spawns the service manager SYNCHRONOUSLY, and this view is polled at 1 s
  // while a job runs.
  const deployment = refresh ? collectDeployment() : collectDeploymentCached();
  const installed = resolveInstalledBinary({ configDir: serverConfigDir() });
  const pending = readPending();

  const reasons: string[] = [];
  if (url === null) reasons.push("no release source is configured (SUBSHELL_RELEASE_URL is empty)");
  if (!deployment.service.supervised) {
    reasons.push(deployment.restart.reason ?? "this server is not running under a service manager");
  }
  const binary = describeBinary(installed);
  if (binary.reason !== null) reasons.push(binary.reason);
  if (pending !== null || updateJobRunning()) reasons.push("an update is already in progress");

  const backupFiles = listBackups();
  return {
    source: { url, enabled: url !== null },
    current: SERVER_VERSION,
    latest,
    latestError,
    updateAvailable: latest !== null && semverLt(SERVER_VERSION, latest.version),
    canApply: { ok: reasons.length === 0, reasons },
    binary,
    paneSafety: deployment.service.paneSafety,
    job,
    lastFailure: readFailed(),
    backups: {
      dir: backupsDir(),
      keep: SUBSHELL_DB_BACKUPS_KEEP,
      count: backupFiles.length,
      // `listBackups` is ordered by the name's own timestamp, NEWEST FIRST —
      // the same order `prune` slices off the tail of, and the same order
      // `status --json` reads `[0]` from. Reading the tail here named the
      // OLDEST snapshot as the latest, which on a host with five of them is a
      // card saying the database was last backed up four updates ago.
      latest: backupFiles[0] ?? null,
    },
  };
}

/**
 * The binary rung, flattened for the wire — and the one place "unwritable"
 * becomes a reason rather than a separate kind, because to the page it is the
 * same answer: this file cannot be replaced, and here is why.
 */
export function describeBinary(installed: InstalledBinary): ServerUpdateView["binary"] {
  if (installed.kind === "source") {
    return { kind: "source", path: null, reason: `${installed.reason} (${installed.argv.join(" ")})` };
  }
  if (installed.kind === "unknown") return { kind: "unknown", path: null, reason: installed.reason };
  const replaceable = binaryIsReplaceable(installed.path);
  return {
    kind: "compiled",
    path: installed.path,
    reason: replaceable.ok ? null : `cannot replace ${installed.path}: ${replaceable.reason}`,
  };
}
