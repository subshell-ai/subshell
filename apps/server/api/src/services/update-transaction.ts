/**
 * The update transaction: a marker written by whoever swaps the binary, and
 * consumed by whoever boots next (spec 2026-09-15 §4.3).
 *
 * The shape follows from one fact: **an updater process cannot see the future
 * boot, but the booting binary can see the past update.** So the process that
 * swaps writes down what it did — the versions, the paths, the backup — and
 * then exits; the NEW binary, at boot, either finishes the transaction
 * (migrations succeeded → audit, delete `.previous` and the marker) or reverts
 * it (migrations failed → restore the backup, swap `.previous` back, record the
 * failure, exit 1 so the manager respawns the old version on the old database).
 *
 * That is what makes the CLI path, the dashboard path and the desktop path ONE
 * implementation: all three do the same swap, and none of them has to stay
 * alive to see whether it worked.
 *
 * **MEASURED (spec §12.3, 2026-09-15, kysely 0.29.5).** A database carrying a
 * migration name the running binary does not know makes `migrateToLatest()`
 * answer `{ error: "corrupted migrations: previously executed migration
 * 0002-b is missing" }`, which `runMigrations()` re-throws. That is the fact
 * the rollback rests on: an OLD binary cannot boot on a NEWER database, so
 * putting the old binary back is not enough — the backup has to come back with
 * it. A test in this suite pins it so a Kysely upgrade that softened it into a
 * warning would be loud rather than silent.
 *
 * **MEASURED (spec §12.2, 2026-09-15, darwin arm64, bun 1.4.2).** `rename(2)`
 * over a RUNNING compiled binary leaves the running process alive and running
 * to completion — unlike overwriting the bytes in place, which the desktop
 * app's sidecar module documents as a SIGKILL. That is why the swap is ONE
 * rename onto the live path ({@link keepPreviousBinary}), and why everything
 * lives inside one directory. The old shape — rename the live binary aside,
 * then rename the new one in — left a window where the path the service
 * definition names held NOTHING, and the boot-revert lives in the missing
 * binary, so only a hand at a keyboard could recover it. The live path is now
 * never moved: `.previous` is made a second name for the running binary
 * first, and a single rename replaces the path underneath the running
 * process. A crash between the two leaves the OLD binary at ExecStart —
 * bootable, and the boot hook's marker/version mismatch converges it to a
 * recorded failure (round-3 sweep C5, 2026-09-24).
 *
 * Everything here is SYNCHRONOUS on purpose: the boot hook runs it before the
 * listener starts, the CLI runs it inside a command, and the whole point of
 * the marker is that it is durable before the next line executes.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { audit } from "@/services/audit.js";
import { restoreDatabase } from "@/services/db-backup.js";
import { resolveSelfUpdate } from "@/services/nodes/update-tracker.js";
import { getLogger } from "@/utils/logger.js";

/** Who asked for this update. Audited, and printed in the failure line. */
export type UpdateOrigin = "cli" | "api" | "desktop";

/** The marker an updater writes immediately before the binary swap. */
export interface PendingUpdate {
  /** The version that was installed BEFORE the swap. */
  from: string;
  /** The version that was installed BY the swap — the one whose boot completes this. */
  to: string;
  /** The installed binary's own path, which now holds `to`. */
  binary: string;
  /** Where the previous binary was moved to; restored on a revert. */
  previousBinary: string;
  /** The snapshot taken before the swap, or `null` when there was no database yet. */
  backup: string | null;
  /** ISO 8601, when the swap began. */
  startedAt: string;
  /** Which surface drove it. */
  origin: UpdateOrigin;
  /** Whether the pane-safety refusal was overridden. */
  forced: boolean;
}

/** A transaction that did not complete, plus what went wrong. */
export interface FailedUpdate extends PendingUpdate {
  /** The migration (or boot) error, flattened to a string — a marker file holds no stack. */
  error: string;
  /** ISO 8601, when the revert ran. */
  failedAt: string;
}

/** Where the markers live. 0700, inside the data dir, so a reset covers them. */
export function updateDir(): string {
  return join(SUBSHELL_SERVER_DATA_DIR, "update");
}

const pendingPath = (dir: string) => join(dir, "pending.json");
const failedPath = (dir: string) => join(dir, "failed.json");
const failedPreviousPath = (dir: string) => join(dir, "failed.previous.json");

/** Read and shape-check a marker file. Anything unreadable is `null`. */
function readMarker<T>(path: string, keys: readonly string[]): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    // A marker missing a field it is acted on by is worse than no marker: the
    // boot hook would swap `undefined` back over the binary. Unreadable and
    // incomplete are therefore one answer.
    for (const key of keys) if (record[key] === undefined) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

const PENDING_KEYS = ["from", "to", "binary", "previousBinary", "startedAt", "origin"] as const;

/** The in-flight update, or null when there is none. */
export function readPending(dir: string = updateDir()): PendingUpdate | null {
  return readMarker<PendingUpdate>(pendingPath(dir), PENDING_KEYS);
}

/** The last update that reverted, or null. Kept until the next `beginUpdate`. */
export function readFailed(dir: string = updateDir()): FailedUpdate | null {
  return readMarker<FailedUpdate>(failedPath(dir), [...PENDING_KEYS, "error", "failedAt"]);
}

/** Write a marker atomically — temp + rename, so a reader never sees half a file. */
function writeMarker(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Open a transaction.
 *
 * Refuses when one is already open, because two overlapping swaps would leave
 * a `.previous` from one update and a marker from the other — and the booting
 * binary would then revert to the wrong version. A stuck marker is cleared by
 * `subshell-server update --rollback`, which the refusal names.
 *
 * A previous FAILURE is moved aside rather than deleted: one level of history,
 * so "the last update failed and here is why" survives exactly one more
 * attempt and no longer.
 */
export function beginUpdate(input: PendingUpdate, dir: string = updateDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(pendingPath(dir))) {
    throw new Error("an update is already in progress; run `subshell-server update --rollback` if it is stuck");
  }
  if (existsSync(failedPath(dir))) {
    try {
      renameSync(failedPath(dir), failedPreviousPath(dir));
    } catch {
      // One level of history is a nicety; failing to keep it must not stop an
      // update the operator asked for.
    }
  }
  writeMarker(pendingPath(dir), input);
}

/** Drop the marker without auditing — the updater's own undo before the swap lands. */
export function clearPending(dir: string = updateDir()): void {
  rmSync(pendingPath(dir), { force: true });
}

/**
 * Make `<binary>.previous` a copy of the RUNNING binary without moving the
 * live path — the first half of every swap on every surface (the dashboard
 * job, the CLI verb, and the node's own port of it), and the reason a crash
 * mid-swap leaves a bootable machine.
 *
 * A hardlink: `.previous` gets a second name for the same inode, so the old
 * bytes stay at `binary` (which is where the service definition points) and
 * the kept copy costs no disk. On a filesystem that refuses links — an
 * EXDEV-shaped bind-mount edge between the binary and its own directory, a
 * FUSE volume with no hardlink support — a real copy is kept instead, flushed
 * to the platter before this returns: a rollback copy that a power loss eats
 * is not a rollback copy.
 *
 * A stale `.previous` from an earlier swap is cleared first (the old
 * rename-aside overwrote it implicitly; a hardlink does not). The caller's
 * rename of the new bytes onto `binary` is the whole swap — see the module
 * header for why that one rename is safe over a running image.
 *
 * The copy fallback is ATOMIC, because `.previous` is a boot target, not a
 * backup: a plain `copyFileSync` interrupted mid-write (ENOSPC, a signal, a
 * power loss) left a TRUNCATED `.previous` standing exactly where `--rollback`
 * and the boot revert look for a working binary. Here the bytes go to a
 * sibling `.tmp-<pid>`, are fsynced, and ONE rename lands them on
 * `<previous>` — a crash mid-copy leaves only the stray tmp name, and
 * `<previous>` is never present-but-incomplete. (The rollback probe below is
 * the second layer: it refuses even a copy truncated by the pre-atomic code,
 * or by a hand.)
 *
 * @returns the previous-binary path, which is `${binary}.previous` — the
 *   marker names this exact spelling everywhere.
 * @internal `seams` exists only so the copy-fallback branch is testable
 *   without a no-link filesystem; production passes nothing.
 */
export function keepPreviousBinary(
  binary: string,
  seams: {
    link?: (from: string, to: string) => void;
    copy?: (from: string, to: string) => void;
  } = {},
): string {
  const previous = `${binary}.previous`;
  rmSync(previous, { force: true });
  try {
    (seams.link ?? linkSync)(binary, previous);
    return previous;
  } catch {
    /* no links here — the atomic copy below */
  }
  const tmp = `${previous}.tmp-${process.pid}`;
  try {
    (seams.copy ?? copyFileSync)(binary, tmp);
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, previous);
  } catch (err) {
    // The refused bytes never reached `<previous>`; sweep the partial.
    rmSync(tmp, { force: true });
    throw err;
  }
  return previous;
}

/**
 * Whether `file` answers `<file> version` with exit 0 — the rollback PROBE,
 * the same question every install path already asks a candidate binary
 * (`update --from` probes before installing; the release ladder probes the
 * download). A `.previous` that cannot say what it is cannot RUN, whatever
 * the stat says.
 */
function rollbackBinaryRuns(file: string): boolean {
  try {
    const res = Bun.spawnSync({ cmd: [file, "version"], stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Finish the transaction: the new binary booted and migrated.
 *
 * Audited with actor `null`, because the booting process holds no session —
 * an API-driven update audits its START separately with the admin as actor
 * (§4.5), so the pair reads as "who asked" and "what happened".
 *
 * The audit is BEST-EFFORT by construction (`audit()` never throws), and the
 * cleanup runs regardless: an update that worked must not be left looking
 * pending because an audit insert failed.
 */
export async function completeUpdate(
  pending: PendingUpdate,
  deps: { dir?: string; audit?: (event: UpdateAuditEvent) => Promise<void> } = {},
): Promise<void> {
  const dir = deps.dir ?? updateDir();
  await (deps.audit ?? auditUpdate)({
    actorUserId: null,
    action: "server.update",
    targetType: "server",
    targetId: null,
    metadataJson: JSON.stringify({
      from: pending.from,
      to: pending.to,
      origin: pending.origin,
      forced: pending.forced ?? false,
      backup: pending.backup,
    }),
  });
  rmSync(pending.previousBinary, { force: true });
  rmSync(pendingPath(dir), { force: true });
  // The tracker's re-creation, beside the audit (design 2026-09-25): the
  // `beginSelfUpdate` entry lived in the process that exited for the manager
  // and is gone, so THIS boot rebuilds it as terminal from the marker. That
  // asymmetry is the whole point of the `recreateFrom` argument — a page
  // loaded after recovery can tell the story even though the ordering press
  // happened in a dead process, and CLI/desktop updates, whose starting half
  // the server process never saw, get their entry HERE.
  resolveSelfUpdate("done", null, { from: pending.from, to: pending.to, startedAt: pending.startedAt });
  getLogger().info(`update complete: ${pending.from} → ${pending.to} (${pending.origin})`);
}

/**
 * Revert the transaction: this binary booted and could not migrate.
 *
 * Order matters and is the reverse of the swap. The DATABASE comes back first,
 * because it is the thing the old binary cannot boot without (the §12.3
 * measurement); the binary second; the marker last, so a crash anywhere in
 * here leaves a marker the next boot still acts on.
 *
 * A missing `.previous` is logged rather than thrown: the database is already
 * restored by then, and the operator needs to be told to reinstall, not to be
 * handed a stack trace by a process that is about to exit.
 *
 * A PRESENT-but-unbootable `.previous` is also not put back — see the probe's
 * comment for the decision and its reasoning. The operator-driven
 * `subshell-server update --rollback` refuses outright; this automatic path
 * records and keeps both files.
 */
export function revertUpdate(
  pending: PendingUpdate,
  error: unknown,
  deps: {
    dir?: string;
    databasePath?: string;
    /**
     * Rollback probe (default: {@link rollbackBinaryRuns}). @internal seam for
     * tests that stage plain files instead of real executables.
     */
    probe?: (file: string) => boolean;
  } = {},
): void {
  const dir = deps.dir ?? updateDir();
  const message = error instanceof Error ? error.message : String(error);
  const log = getLogger();

  if (pending.backup !== null) {
    try {
      // The database THIS process would open, which is the one whose binary
      // the marker's writer swapped. Injectable only so a test can revert over
      // a temp file instead of the suite's own shared database.
      restoreDatabase(pending.backup, deps.databasePath);
      log.info(`update revert: restored the database from ${pending.backup}`);
    } catch (restoreError) {
      // Say so loudly and keep going: the binary swap is still worth undoing,
      // and the marker below is what tells anyone what state this host is in.
      log.withError(restoreError).error(`update revert: could NOT restore ${pending.backup}`);
    }
  } else {
    log.info("update revert: there was no database to restore");
  }

  if (existsSync(pending.previousBinary)) {
    let bootable = false;
    try {
      bootable = (deps.probe ?? rollbackBinaryRuns)(pending.previousBinary);
    } catch {
      bootable = false;
    }
    if (!bootable) {
      // THE DECISION on an automatic revert whose copy fails the probe (round-3
      // review, finding 2): record, do not swap, keep the copy. The operator's
      // `update --rollback` REFUSES in this case — there is a human, and
      // refusing costs nothing. Here there is no human, and the choice is
      // between two crash loops: renaming an unbootable copy onto the path the
      // service definition names leaves the manager unable to EXEC anything —
      // no journal line from the binary, and the boot-revert logic that could
      // notice all lives inside a file that cannot run, now buried at the
      // live path with the copy destroyed by the rename. Leaving the
      // refused-to-migrate new binary in place keeps a process that boots,
      // logs the migration failure on every attempt, and leaves the whole
      // incident legible (`failed.json` below plus the executable
      // `.previous` kept as evidence). The machine needs an operator in both
      // worlds; this one keeps talking until they arrive, and says what to
      // do. The database restore above stands either way — that half is
      // correct regardless of which file boots.
      log.error(
        `update revert: ${pending.previousBinary} did not answer \`version\`, so it was NOT put back over ${pending.binary}; the copy is kept — reinstall ${pending.from} by hand`,
      );
    } else {
      try {
        renameSync(pending.previousBinary, pending.binary);
        log.info(`update revert: put ${pending.from} back at ${pending.binary}`);
      } catch (swapError) {
        log
          .withError(swapError)
          .error(`update revert: could NOT put ${pending.previousBinary} back; reinstall ${pending.binary} by hand`);
      }
    }
  } else {
    log.error(`update revert: ${pending.previousBinary} is gone; reinstall ${pending.from} by hand`);
  }

  const failed: FailedUpdate = { ...pending, error: message, failedAt: new Date().toISOString() };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeMarker(failedPath(dir), failed);
  } catch (markerError) {
    log.withError(markerError).error("update revert: could not write failed.json");
  }
  rmSync(pendingPath(dir), { force: true });
  // The tracker's side of the failure story (design 2026-09-25). Stated
  // honestly: this boot exits 1 right after the revert, so for the AUTOMATIC
  // revert this entry mostly records the fact in the process that made it —
  // the durable half is `failed.json`, which the view already renders as
  // `lastFailure`. It is the non-exiting rollback that reads the tracker.
  resolveSelfUpdate("failed", message, { from: pending.from, to: pending.to, startedAt: pending.startedAt });
  log.error(`update ${pending.from} → ${pending.to} FAILED and ${pending.from} was restored: ${message}`);
}

/**
 * Record a pending update whose binary never booted.
 *
 * The case: the marker says `to`, and the process reading it is some OTHER
 * version — the new binary died before this line, and the CLI (or a hand) put
 * an older one back. Nothing here reverts anything, because the swap has
 * already been undone by whoever put this binary in place; what is missing is
 * the RECORD, and without it the marker would sit there refusing the next
 * `beginUpdate` forever.
 */
export function recordFailure(pending: PendingUpdate, reason: string, dir: string = updateDir()): void {
  const failed: FailedUpdate = { ...pending, error: reason, failedAt: new Date().toISOString() };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeMarker(failedPath(dir), failed);
  } catch {
    // Best effort; the log line below is the other record.
  }
  rmSync(pendingPath(dir), { force: true });
  // Unlike the revert above, THIS recorder's boot survives — the old binary
  // the manager respawned is still serving pages — so the tracker entry here
  // is the half a later page load actually reads (design 2026-09-25).
  resolveSelfUpdate("failed", reason, { from: pending.from, to: pending.to, startedAt: pending.startedAt });
  getLogger().error(`update ${pending.from} → ${pending.to} did not complete: ${reason}`);
}

/** The audit shape this module writes — `services/audit.ts`'s input, restated so the dep is injectable. */
export interface UpdateAuditEvent {
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadataJson: string | null;
}

/**
 * The production audit sink.
 *
 * A STATIC import (the no-dynamic-imports rule), and safe for the CLI graph
 * that reaches this module: `services/audit.ts` builds its `AuditRepository`
 * on first use and `db/index.ts`'s Kysely handle opens SQLite lazily through
 * the dialect's factory, so evaluating either opens nothing. It is still
 * injectable, so {@link completeUpdate} can be tested with no database at all.
 */
async function auditUpdate(event: UpdateAuditEvent): Promise<void> {
  await audit(event);
}
