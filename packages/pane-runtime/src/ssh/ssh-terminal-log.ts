import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isNodeSubshellId, type SshControlMode } from "@internal/subshell-protocol";

/**
 * The managed-SSH-terminal state: input-control mode + generation, the
 * rotation bookkeeping, and the cursor-honest log reader (SSH-SUPPORT.md §3:
 * "Active SSH terminal logs need bounded rotation with an explicit
 * cursor-expired/reset result, never silent cursor reuse. Use log generation
 * plus byte offset where rotation occurs").
 *
 * The log FILE itself stays at the conventional pane path
 * `<dataDir>/subshells/<id>.log` so the existing tail pumps, replay capture,
 * and the non-SSH byte-cursor contract are untouched — rotation renames it to
 * `<id>.log.1` (ONE rotated segment, that is the bound) and the capture child
 * is re-armed onto a fresh file at the original name by the caller (the agent
 * executor owns the tmux re-arm; this module owns only disk facts, so the
 * server-hosted node can share it without tmux).
 *
 * The cursor contract: a reader's position is the pair
 * (logGeneration, byteOffset). A read may advance only within the CURRENT
 * generation; anything older is answered `cursor-expired` with the current
 * generation, never silently re-anchored onto bytes the reader never saw.
 * A `fromByte` beyond EOF within the same generation is the same signal —
 * a file that got reset underneath a held cursor is exactly what the
 * generation exists to detect.
 *
 * The input-control state is PERSISTED (0600, temp+rename) because panes
 * outlive the daemon (`KillMode=process` keeps tmux children through a
 * restart): a takeover fenced before the restart must still fence after it,
 * and a replayed older transition must still be refused.
 */

/** Per-terminal log segment size before rotation. Chosen locally (not a frozen protocol row): it is a scrollback bound, and the aggregate 1 GiB quota (§3's table) is the ceiling that matters — two segments per pane keeps any one terminal's hold at 4 MiB while staying generous enough that rotation is rare. */
export const SSH_TERMINAL_LOG_SEGMENT_BYTES = 2 * 1024 * 1024;

/** The persisted per-terminal node state. */
export interface SshTerminalState {
  /** Whose input the node currently accepts (only `ssh_input_control` moves this). */
  mode: SshControlMode;
  /** The plane's authoritative input-generation counter mirrored here; transitions that would LOWER it are refused. */
  generation: number;
  /** Rotation counter: the log cursor's second half. Bumped by every rotation AND every fresh launch (a new session is a new log, not a continuation). */
  logGeneration: number;
}

/** Guard + path composition: a malformed pane id is a throw, never a path (the `assertNodePathId` posture). */
export function assertSshTerminalId(subshellId: string): void {
  if (!isNodeSubshellId(subshellId)) throw new Error("invalid subshell id");
}

function statePath(dataDir: string, subshellId: string): string {
  assertSshTerminalId(subshellId);
  return join(dataDir, "ssh", "terminals", `${subshellId}.json`);
}

/** The pane's SSH terminal log path (conventional subtree; the rotation sibling is `${path}.1`). */
export function terminalLogPath(dataDir: string, subshellId: string): string {
  assertSshTerminalId(subshellId);
  return join(dataDir, "subshells", `${subshellId}.log`);
}

/** Read the persisted state; null when the pane has none (unknown to this machine's SSH half). */
export function readTerminalState(dataDir: string, subshellId: string): SshTerminalState | null {
  let path: string;
  try {
    path = statePath(dataDir, subshellId);
  } catch {
    return null;
  }
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    const raw = JSON.parse(readFileSyncWithNoFollow(path));
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw.mode === "agent" || raw.mode === "human") &&
      Number.isInteger(raw.generation) &&
      (raw.generation as number) >= 1 &&
      Number.isInteger(raw.logGeneration) &&
      (raw.logGeneration as number) >= 1
    ) {
      return { mode: raw.mode, generation: raw.generation as number, logGeneration: raw.logGeneration as number };
    }
    return null;
  } catch {
    return null;
  }
}

function readFileSyncWithNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    const buf = Buffer.allocUnsafe(Math.max(1, st.size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function writeStateAtomic(path: string, state: SshTerminalState): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function ensureTerminalsDir(dataDir: string): void {
  const dir = join(dataDir, "ssh", "terminals");
  try {
    lstatSync(dir);
  } catch {
    // mkdir's mode option is umask-masked: create, then re-tighten (the
    // staging-dir.ts pattern).
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort; the state files inside are the sensitive half
    }
  }
}

/**
 * Arm a freshly launched managed terminal: keep any prior control mode and
 * generation (they fence input across restarts and must never lower), bump
 * the LOG generation (a new session's bytes are not the continuation an old
 * cursor points into), and start the pane log clean (old file + rotated
 * segment removed — the plane owns the row's history retention; the log is
 * recreated by the re-armed capture child).
 */
export function initTerminalForLaunch(dataDir: string, subshellId: string): SshTerminalState {
  const existing = readTerminalState(dataDir, subshellId);
  const state: SshTerminalState = {
    mode: existing?.mode ?? "agent",
    generation: existing?.generation ?? 1,
    logGeneration: (existing?.logGeneration ?? 0) + 1,
  };
  ensureTerminalsDir(dataDir);
  writeStateAtomic(statePath(dataDir, subshellId), state);
  for (const p of [terminalLogPath(dataDir, subshellId), `${terminalLogPath(dataDir, subshellId)}.1`]) {
    try {
      const st = lstatSync(p);
      if (st.isFile() || st.isSymbolicLink()) unlinkSync(p);
    } catch {
      // nothing there yet
    }
  }
  return state;
}

/** Outcome of an input-control transition. */
export type SshControlTransition =
  | { kind: "applied"; state: SshTerminalState }
  /** The requested generation is LOWER than the node's — the fenced event replayed; nothing moved. */
  | { kind: "stale"; state: SshTerminalState };

/**
 * Apply a control transition (§3: takeover/return RAISES the generation; the
 * node refuses anything that would LOWER it, so a replayed old transition
 * cannot un-fence input). Equal generation is idempotent: the mode is
 * re-asserted and the same state echoed (the answer's job is "what took
 * effect", which lets the plane detect a lost race at the machine).
 */
export function transitionControl(
  dataDir: string,
  subshellId: string,
  mode: SshControlMode,
  generation: number,
): SshControlTransition {
  ensureTerminalsDir(dataDir);
  const current = readTerminalState(dataDir, subshellId) ?? { mode: "agent", generation: 1, logGeneration: 1 };
  if (generation < current.generation) return { kind: "stale", state: current };
  const state: SshTerminalState = { ...current, mode, generation };
  writeStateAtomic(statePath(dataDir, subshellId), state);
  return { kind: "applied", state };
}

/** Current control state for the generic-pane input gates (workstream C's seam); null when the pane is not a managed SSH terminal here. */
export function controlStateFor(
  dataDir: string,
  subshellId: string,
): { mode: SshControlMode; generation: number } | null {
  const state = readTerminalState(dataDir, subshellId);
  return state === null ? null : { mode: state.mode, generation: state.generation };
}

/** A bounded terminal-log read result. */
export type SshTerminalLogRead =
  | {
      status: "ok";
      /** The generation read FROM (echo of the request's, which matched). */
      generation: number;
      bytes: Buffer;
      /** Offset to pass next. */
      nextByte: number;
      /** Current segment size, so the caller can watch rotation-adjacent growth. */
      size: number;
    }
  | {
      status: "cursor-expired";
      /** The CURRENT generation; the caller re-anchors here (or replays from a capture). */
      generation: number;
      /** Current segment size. */
      size: number;
    };

/**
 * Read at most `maxBytes` from a managed terminal log held at
 * (generation, fromByte). Refusals to chase: the file is opened
 * `O_RDONLY | O_NOFOLLOW` and fstat'd through the fd, and a generation that
 * is not the current one is answered `cursor-expired` — the ONLY sanctioned
 * way for a stale cursor to learn the truth (§3's never-silent-reuse rule).
 */
export function readTerminalLog(
  dataDir: string,
  subshellId: string,
  generation: number,
  fromByte: number,
  maxBytes: number,
): SshTerminalLogRead {
  const state = readTerminalState(dataDir, subshellId) ?? { mode: "agent", generation: 1, logGeneration: 1 };
  const path = terminalLogPath(dataDir, subshellId);
  let size = 0;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    size = st.isFile() ? st.size : 0;
  } catch {
    size = 0; // never created yet: an empty current segment
  }
  try {
    if (generation !== state.logGeneration || fromByte > size) {
      return { status: "cursor-expired", generation: state.logGeneration, size };
    }
    if (fromByte === size || maxBytes <= 0) {
      return { status: "ok", generation, bytes: Buffer.alloc(0), nextByte: fromByte, size };
    }
    if (fd === null) return { status: "ok", generation, bytes: Buffer.alloc(0), nextByte: fromByte, size };
    const len = Math.min(maxBytes, size - fromByte);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, fromByte + got);
      if (n <= 0) break;
      got += n;
    }
    return { status: "ok", generation, bytes: buf.subarray(0, got), nextByte: fromByte + got, size };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Rotate one terminal log if the current segment exceeds `maxBytes`:
 * unlink the previous rotated segment, rename the current one to `.1`, and
 * bump the generation so every held cursor comes back `cursor-expired`. The
 * CALLER re-arms the pane capture (tmux `pipe-pane` without `-o`) onto the
 * fresh name afterward — this module deliberately knows nothing about tmux
 * so the server-hosted node can share it. A symlink at either name is
 * refused, not chased. Returns the new state, or null when no rotation was
 * needed (or the pane is unknown to this machine).
 */
export function rotateTerminalLogIfNeeded(
  dataDir: string,
  subshellId: string,
  maxBytes: number = SSH_TERMINAL_LOG_SEGMENT_BYTES,
): SshTerminalState | null {
  const path = terminalLogPath(dataDir, subshellId);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null; // no log yet
  }
  if (!st.isFile() || st.size <= maxBytes) return null;
  const state = readTerminalState(dataDir, subshellId) ?? { mode: "agent", generation: 1, logGeneration: 1 };
  const rotated = `${path}.1`;
  try {
    const old = lstatSync(rotated);
    if (old.isFile() || old.isSymbolicLink()) unlinkSync(rotated);
  } catch {
    // no previous segment
  }
  if (lstatSync(path).isSymbolicLink()) return null; // re-check: refuse to rename a planted link
  renameSync(path, rotated);
  const next: SshTerminalState = { ...state, logGeneration: state.logGeneration + 1 };
  writeStateAtomic(statePath(dataDir, subshellId), next);
  return next;
}
