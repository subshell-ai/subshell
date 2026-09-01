/**
 * Per-command `result{data}` contracts for the node link (spec 2026-08-31 §3.2/§3.3).
 * Phase 0 froze the FRAME shapes; this file freezes what each command's `data`
 * member carries. The agent is the sole producer, the backend's RemoteLauncher
 * the sole consumer — but both sides validate, and this package is the shared
 * source of truth so the two tracks cannot drift. Additive contract file
 * (phase-2): NODE_PROTOCOL_VERSION stays 1 because no frozen frame changed.
 *
 * `launch` / `terminate` / `kill` / `input` / `resize` / `tail_start` /
 * `tail_stop` / `remove_paths` / `inventory` / `ping` carry no data — their
 * success result is just `{ ok: true }`, so they need no validator here.
 *
 * Validators are hand-rolled in the `parseNodeEvent` style (this package stays
 * schema-lib-free); a NON-null return is safe to cast.
 */

/** Strict base64 (same discipline as `node-frames.ts`; local copy by design). */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/* ------------------------------------------------------------------ */
/* guards (mirrors the local-helper style of node-frames.ts)           */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStr(value: unknown): value is string {
  return typeof value === "string";
}
function isNonEmptyStr(value: unknown): value is string {
  return isStr(value) && value.length > 0;
}
function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isInt(value: unknown): value is number {
  return isNum(value) && Number.isInteger(value);
}
function isBool(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/* ------------------------------------------------------------------ */
/* probe                                                               */
/* ------------------------------------------------------------------ */

/** One row of a `probe` batch result (spec §6.3 reconcile: has-session + exit + title + optional capture). */
export interface NodeProbeEntry {
  /** mote session id this row describes */
  sessionId: string;
  /** True while the pane process is alive on the node */
  alive: boolean;
  /** Last observed exit code; null while alive or when the exit was never seen */
  exitCode: number | null;
  /** tmux pane title, when the probe captured one */
  title?: string;
  /** Command line running in the pane, when captured */
  command?: string;
  /** Raw screen capture of the pane, when the probe requested one */
  capture?: string;
}

/**
 * Validates and narrows a `probe` command's `result{data}` into its entry list.
 * @param data - the `data` member of a successful result frame (any JSON value)
 * @returns the narrowed entries, or null when the payload is malformed
 */
export function parseNodeProbeEntries(data: unknown): NodeProbeEntry[] | null {
  if (!Array.isArray(data)) return null;
  for (const e of data) {
    if (!isRecord(e) || !isStr(e.sessionId) || !isBool(e.alive)) return null;
    if (!(e.exitCode === null || isInt(e.exitCode))) return null;
    if ("title" in e && !isStr(e.title)) return null;
    if ("command" in e && !isStr(e.command)) return null;
    if ("capture" in e && !isStr(e.capture)) return null;
  }
  return data as unknown as NodeProbeEntry[];
}

/* ------------------------------------------------------------------ */
/* stat_dir                                                            */
/* ------------------------------------------------------------------ */

/**
 * `stat_dir` answer. Success-only: a missing path or a non-directory answers
 * `result{ok:false}` (the launcher turns those into a user-facing error), so
 * `exists` is implied by the frame arriving `ok:true`.
 */
export interface NodeStatDirResult {
  /** Absolute path that was stat-ed (echo of the request) */
  path: string;
  /** True when the path exists and is a directory */
  isDirectory: boolean;
}

/**
 * Validates and narrows a `stat_dir` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodeStatDirResult(data: unknown): NodeStatDirResult | null {
  if (!isRecord(data) || !isStr(data.path) || !isBool(data.isDirectory)) return null;
  return data as unknown as NodeStatDirResult;
}

/* ------------------------------------------------------------------ */
/* log_read                                                            */
/* ------------------------------------------------------------------ */

/**
 * `log_read` answer: the requested byte window plus the whole-file size, which
 * lets a relay compute a tail window (e.g. "last 64 KiB") in one round-trip
 * instead of stat-then-read (phase-2 plan, Task 11).
 */
export interface NodeLogReadResult {
  /** Strict-base64 of the bytes read; empty when the window was empty */
  bytes_b64: string;
  /** Absolute offset to read from next (request's `fromByte` + bytes returned) */
  next: number;
  /** Total size of the whole log file on the node */
  size: number;
}

/**
 * Validates and narrows a `log_read` command's `result{data}`.
 * Invariant: base64 payload, non-negative integer offsets, and an empty read
 * must not report an offset past EOF (`bytes_b64 === "" ? next <= size : true`).
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodeLogReadResult(data: unknown): NodeLogReadResult | null {
  if (!isRecord(data)) return null;
  if (!isStr(data.bytes_b64) || !BASE64_RE.test(data.bytes_b64)) return null;
  if (!isInt(data.next) || (data.next as number) < 0) return null;
  if (!isInt(data.size) || (data.size as number) < 0) return null;
  if (data.bytes_b64 === "" && (data.next as number) > (data.size as number)) return null;
  return data as unknown as NodeLogReadResult;
}

/* ------------------------------------------------------------------ */
/* scalar results                                                      */
/* ------------------------------------------------------------------ */

/** `prompt_deliver` answer: whether the settle loop managed to type the prompt before timing out. */
export interface NodePromptDeliverResult {
  /** True when the prompt was typed and Enter pressed while the pane was settled */
  promptDelivered: boolean;
}

/**
 * Validates and narrows a `prompt_deliver` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodePromptDeliver(data: unknown): NodePromptDeliverResult | null {
  if (!isRecord(data) || !isBool(data.promptDelivered)) return null;
  return data as unknown as NodePromptDeliverResult;
}

/** `probe_resume` answer: whether the harness reports the pinned conversation as resumable on this node. */
export interface NodeProbeResumeResult {
  /** True when `harnessId` can resume `harnessSessionId` at the probed cwd */
  canResume: boolean;
}

/**
 * Validates and narrows a `probe_resume` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodeProbeResume(data: unknown): NodeProbeResumeResult | null {
  if (!isRecord(data) || !isBool(data.canResume)) return null;
  return data as unknown as NodeProbeResumeResult;
}

/** `write_file` answer, sent on EVERY chunk (spec §3.4): confirms the write and reports progress. */
export interface NodeWriteFileResult {
  /** Destination path on the node (echo of the request) */
  path: string;
  /** Running byte total written to `path` so far across all chunks */
  received: number;
}

/**
 * Validates and narrows a `write_file` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodeWriteFileResult(data: unknown): NodeWriteFileResult | null {
  if (!isRecord(data) || !isNonEmptyStr(data.path) || !isInt(data.received) || (data.received as number) < 0)
    return null;
  return data as unknown as NodeWriteFileResult;
}

/**
 * Validates and narrows a `capture` command's `result{data}` — the raw pane
 * screen as a bare string (empty screen answers `""`).
 * @param data - the `data` member of a successful result frame
 * @returns the capture string, or null when malformed
 */
export function parseNodeCaptureResult(data: unknown): string | null {
  return isStr(data) ? data : null;
}
