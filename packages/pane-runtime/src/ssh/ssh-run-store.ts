import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isNodeSubshellId, type SshRunFactsWire, type SshRunLifecycle } from "@internal/subshell-protocol";

/**
 * The durable run store (SSH-SUPPORT.md §3, Durable dispatch and storage).
 *
 * Layout under `<dataDir>/ssh/runs/<runId>/`, one directory per run:
 *
 * - `accept.json` — the immutable acceptance record (request digest, command,
 *   deadline, acceptedAt). Written BEFORE any spawn; its existence IS the
 *   dedup record, so deleting output never deletes replay protection.
 * - `state.json`  — the mutable lifecycle facts (temp+rename 0600, the
 *   `maintenance.json` pattern: a torn write can never be read as state).
 * - `stdout.log` / `stderr.log` — the output, kept separate, capped by the
 *   supervisor's drain and by eviction, 0600.
 * - `config`      — the rendered ssh config for that run's invocations.
 *
 * Filesystem hygiene mirrors the node's existing discipline: ids re-checked
 * at every composition site (`assertSshRunPath` throws, never composes), dirs
 * 0700 and files 0600 (`mkdir`'s mode is umask-masked, so a chmod follows a
 * fresh create), symlinks refused via `O_NOFOLLOW` + `lstat` on create, read,
 * and cleanup, and every sweep stays shallow inside the ONE subtree it owns.
 */

/** The immutable half of a run's record. */
export interface SshRunAcceptance {
  runId: string;
  /** Lowercase-hex sha256 of the complete request, echoed from the wire — the dedup's second half. */
  requestDigest: string;
  acceptedAtMs: number;
  /** The request facts kept on this disk only: command text never leaves for logs, audit, or notifications. */
  command: string;
  remoteDir: string | null;
  deadlineMs: number;
}

/** The mutable half: everything the facts envelope reports, plus store bookkeeping. */
export interface SshRunState {
  runId: string;
  lifecycle: SshRunLifecycle;
  cancelRequested: boolean;
  cancelLocalConfirmed: boolean;
  deadlineHit: boolean;
  remoteStatus: number | null;
  remoteStatusConfirmed: boolean;
  localExitCode: number | null;
  localExitSignal: string | null;
  /** Wall clock at spawn (null until spawned; an `accepted` state with null here at boot-read is the crash-between-accept-and-spawn case). */
  startedAtMs: number | null;
  /** Wall clock at the terminal transition; the retention age anchor. Null until `completed`/`unknown`. */
  finishedAtMs: number | null;
  /** Output files were evicted under storage pressure; the facts stand, the bytes are gone. */
  outputEvicted: boolean;
  /** The combined 10 MiB retention was exceeded and the drain discarded bytes (the read answer's `truncated`). */
  outputTruncated?: boolean;
  /** True once the supervisor had actually spawned the child (accept → spawn crash discrimination). */
  spawned: boolean;
}

/** Refuse to compose a path from an id the plane could not have minted; the throw is the guard, callers surface it as a refusal. */
export function assertSshRunPath(dataDir: string, runId: string): string {
  // The wire's `isSshRunId` is deliberately loose (it guards the FRAME);
  // path composition demands the plane's minted shape — hex + hyphen, ≤ 64,
  // exactly the `isNodeSubshellId` grammar the run-id doc names. This is the
  // node's composition-site guard: a throw, never a composed path.
  if (!isNodeSubshellId(runId)) throw new Error("invalid ssh run id");
  return join(dataDir, "ssh", "runs", runId);
}

/** True only for a REAL directory (a symlink at the name is not ours to enter). */
function isRealDir(st: ReturnType<typeof lstatSync> | undefined): st is ReturnType<typeof lstatSync> {
  return st?.isDirectory();
}

function lstatSafe(p: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

/** Root of the runs subtree. */
export function sshRunsDir(dataDir: string): string {
  return join(dataDir, "ssh", "runs");
}

/** Create `<dataDir>/ssh` + `<dataDir>/ssh/runs` (idempotent, mode re-tightened after a fresh create). */
export function ensureSshDirs(dataDir: string): void {
  for (const dir of [join(dataDir, "ssh"), sshRunsDir(dataDir)]) {
    const existed = isRealDir(lstatSafe(dir));
    mkdirSync(dir, { recursive: true });
    if (!existed) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        // an unlinkable just-created dir fails the caller's next write anyway
      }
    }
  }
}

function readJsonSafe<T>(path: string): T | null {
  try {
    // lstat first: the state/accept files are regular files BY OUR CREATION;
    // a planted symlink is refused, not followed.
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic single-flag state writer: temp in the SAME dir + rename (the maintenance.json pattern), 0600. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the temp is already gone
    }
    throw err;
  }
}

/** Input to {@link acceptRun} — the request facts the store keeps; nothing derived from a snapshot besides its rendered config text. */
export interface SshRunRequestFacts {
  runId: string;
  requestDigest: string;
  command: string;
  remoteDir: string | null;
  deadlineMs: number;
  /** The ssh config file text {@link buildSshInvocation} will run against; stored with the acceptance, before any spawn. */
  snapshotConfigText: string;
}

/**
 * Durably record acceptance BEFORE any spawn.
 *
 * - fresh id → writes `accept.json` + `state.json {lifecycle: accepted}` +
 *   the rendered config, and returns `{kind: "accepted"}`.
 * - id already accepted, SAME digest → `{kind: "duplicate"}` with the stored
 *   record: duplicate delivery returns existing state and spawns nothing.
 * - id already accepted, DIFFERENT digest → `{kind: "conflict"}` (the
 *   `run_conflict` refusal); the earlier request stands, nothing was spawned
 *   twice, and NOTHING here retries.
 *
 * A crash between `accept.json` and `state.json` leaves a record with no
 * state; the same request re-landing finds the digest match, rewrites state,
 * and answers as an ordinary fresh accept. A crash between acceptance and
 * SPAWN is the supervisor/boot reconcile's `unknown` case, never a retry.
 *
 * @throws on a malformed id (path guard) or an unwritable data dir.
 */
export function acceptRun(
  dataDir: string,
  req: SshRunRequestFacts,
  nowMs: number,
):
  | { kind: "accepted" }
  | { kind: "duplicate"; acceptance: SshRunAcceptance; state: SshRunState }
  | { kind: "conflict" } {
  const dir = assertSshRunPath(dataDir, req.runId);
  ensureSshDirs(dataDir);
  const acceptancePath = join(dir, "accept.json");
  const statePath = join(dir, "state.json");
  const existing = readJsonSafe<SshRunAcceptance>(acceptancePath);
  const freshState: SshRunState = {
    runId: req.runId,
    lifecycle: "accepted",
    cancelRequested: false,
    cancelLocalConfirmed: false,
    deadlineHit: false,
    remoteStatus: null,
    remoteStatusConfirmed: false,
    localExitCode: null,
    localExitSignal: null,
    startedAtMs: null,
    finishedAtMs: null,
    outputEvicted: false,
    spawned: false,
  };
  if (existing !== null) {
    if (existing.requestDigest !== req.requestDigest) return { kind: "conflict" };
    const state = readJsonSafe<SshRunState>(statePath);
    if (state !== null) return { kind: "duplicate", acceptance: existing, state };
    // accepted-but-stateless residue (crash between the two writes): re-write
    // state and fall through as the SAME request; no second acceptance.
  } else {
    if (lstatSafe(dir) !== undefined && !isRealDir(lstatSafe(dir))) throw new Error("run path occupied");
    mkdirSync(dir, { mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // see ensureSshDirs
    }
    const acceptance: SshRunAcceptance = {
      runId: req.runId,
      requestDigest: req.requestDigest,
      acceptedAtMs: nowMs,
      command: req.command,
      remoteDir: req.remoteDir,
      deadlineMs: req.deadlineMs,
    };
    writeJsonAtomic(acceptancePath, acceptance);
    // The rendered config lands with the acceptance, before any spawn: the
    // child NEVER sees a config this store did not write first, and a crash
    // after accept still leaves everything a reconcile needs.
    writeFileSync(join(dir, "config"), req.snapshotConfigText, { mode: 0o600 });
  }
  writeJsonAtomic(statePath, freshState);
  return { kind: "accepted" };
}

/** Read one run's acceptance + state; null when the run was never accepted (the `run_unknown` branch) or the id will not compose. */
export function readRun(dataDir: string, runId: string): { acceptance: SshRunAcceptance; state: SshRunState } | null {
  let dir: string;
  try {
    dir = assertSshRunPath(dataDir, runId);
  } catch {
    return null;
  }
  const acceptance = readJsonSafe<SshRunAcceptance>(join(dir, "accept.json"));
  const state = readJsonSafe<SshRunState>(join(dir, "state.json"));
  if (acceptance === null || state === null) return null;
  return { acceptance, state };
}

/** Persist the mutable state atomically; the caller owns the transitions. */
export function writeRunState(dataDir: string, state: SshRunState): void {
  const dir = assertSshRunPath(dataDir, state.runId);
  writeJsonAtomic(join(dir, "state.json"), state);
}

/** Build the frozen facts envelope from stored state. */
export function buildRunFacts(state: SshRunState): SshRunFactsWire {
  return {
    runId: state.runId,
    lifecycle: state.lifecycle,
    cancelRequested: state.cancelRequested,
    cancelLocalConfirmed: state.cancelLocalConfirmed,
    deadlineHit: state.deadlineHit,
    remoteStatus: state.remoteStatus,
    remoteStatusConfirmed: state.remoteStatusConfirmed,
    localExitCode: state.localExitCode,
    localExitSignal: state.localExitSignal,
  };
}

/** One run's output stream, as files on disk. */
export type SshRunStream = "stdout" | "stderr";

/** Path of one stream file (id-guarded). */
export function runStreamPath(dataDir: string, runId: string, stream: SshRunStream): string {
  return join(assertSshRunPath(dataDir, runId), `${stream}.log`);
}

/**
 * Open a stream file for APPEND: creates 0600 (umask only clears bits, and
 * 0600 has none to clear), refuses an existing SYMLINK at the name via
 * `O_NOFOLLOW`, and hands back a plain fd the supervisor's drain loop writes.
 * A symlink planted later cannot redirect an already-open fd.
 */
export function openRunStreamAppend(dataDir: string, runId: string, stream: SshRunStream): number {
  const path = runStreamPath(dataDir, runId, stream);
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
}

/** Retained byte size of one stream file (0 when absent — the evicted/never-written case). */
export function runStreamSize(dataDir: string, runId: string, stream: SshRunStream): number {
  const st = lstatSafe(runStreamPath(dataDir, runId, stream));
  return st?.isFile() ? Number(st.size) : 0;
}

/**
 * Read up to `maxBytes` of one stream starting at `fromByte`.
 *
 * Opens `O_RDONLY | O_NOFOLLOW` and fstats the RESULTING fd, so the size and
 * the bytes describe the same file — no swap-the-name race. A read starting
 * past EOF yields zero bytes and the honest `total`; the caller tells "not
 * yet" from "the cursor outlived the data" by the eviction flag, never by
 * guessing.
 */
export function readRunStreamWindow(
  dataDir: string,
  runId: string,
  stream: SshRunStream,
  fromByte: number,
  maxBytes: number,
): { bytes: Buffer; total: number } {
  const path = runStreamPath(dataDir, runId, stream);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { bytes: Buffer.alloc(0), total: 0 };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { bytes: Buffer.alloc(0), total: 0 };
    const total = st.size;
    if (fromByte >= total || maxBytes <= 0) return { bytes: Buffer.alloc(0), total };
    const len = Math.min(maxBytes, total - fromByte);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, fromByte + got);
      if (n <= 0) break;
      got += n;
    }
    return { bytes: buf.subarray(0, got), total };
  } finally {
    closeSync(fd);
  }
}

/** Every run id currently recorded as a real directory; a stray name is left alone. */
export function listRunIds(dataDir: string): string[] {
  const dir = sshRunsDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => isNodeSubshellId(n) && isRealDir(lstatSafe(join(dir, n))));
}

/**
 * Bytes the runs half of the aggregate SSH output store holds: every regular
 * file under the run dirs, via lstat (a symlink leaf contributes 0 and is
 * never chased). The caller adds managed-terminal log bytes; together they
 * are the {@link SSH_AGGREGATE_OUTPUT_STORAGE_BYTES} number.
 */
export function sshRunsStorageBytes(dataDir: string): number {
  let total = 0;
  for (const id of listRunIds(dataDir)) {
    const dir = join(sshRunsDir(dataDir), id);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const st = lstatSync(join(dir, name));
        if (st.isFile()) total += Number(st.size);
      } catch {
        // vanished mid-scan
      }
    }
  }
  return total;
}

/**
 * Evict completed output, oldest-finished first, until `freedNeeded` bytes
 * are recovered (or nothing is left to evict). NEVER throws.
 *
 * Eviction deletes the OUTPUT of completed/unknown runs only — never the
 * acceptance record (dedup survives its own disk pressure: deleting output
 * must not delete replay protection), never a run still
 * `accepted`/`running` (a live process owns those files), and never anything
 * under an unreadable state (unknown is not evictable).
 */
export function evictCompletedOutput(dataDir: string, freedNeeded: number, nowMs: number): number {
  let freed = 0;
  const candidates: { id: string; ageMs: number }[] = [];
  for (const id of listRunIds(dataDir)) {
    const rec = readRun(dataDir, id);
    if (!rec) continue;
    const { state } = rec;
    if (state.lifecycle !== "completed" && state.lifecycle !== "unknown") continue;
    if (state.outputEvicted) continue;
    candidates.push({ id, ageMs: nowMs - (state.finishedAtMs ?? rec.acceptance.acceptedAtMs) });
  }
  candidates.sort((a, b) => b.ageMs - a.ageMs);
  for (const c of candidates) {
    if (freed >= freedNeeded) break;
    for (const stream of ["stdout", "stderr"] as const) {
      try {
        const path = runStreamPath(dataDir, c.id, stream);
        const st = lstatSafe(path);
        if (st?.isFile()) {
          unlinkSync(path);
          freed += Number(st.size);
        }
      } catch {
        // vanished mid-eviction: already gone
      }
    }
    const rec = readRun(dataDir, c.id);
    if (rec) writeRunState(dataDir, { ...rec.state, outputEvicted: true });
  }
  return freed;
}

/**
 * Delete a whole run subtree. The id is re-guarded here (defense-in-depth),
 * and a symlink at the run-dir name is UNLINKED, never followed into.
 * Callers (retention) additionally gate on lifecycle/age.
 */
export function removeRunDir(dataDir: string, runId: string): void {
  const dir = assertSshRunPath(dataDir, runId);
  const st = lstatSafe(dir);
  if (st === undefined) return;
  if (st.isSymbolicLink()) {
    unlinkSync(dir);
    return;
  }
  if (!st.isDirectory()) return; // a stray regular file at the name is not ours to rm recursively
  rmSync(dir, { recursive: true, force: true });
}
