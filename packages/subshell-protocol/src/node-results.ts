/**
 * Per-command `result{data}` contracts for the node link (spec 2026-08-31 §3.2/§3.3).
 * Phase 0 froze the FRAME shapes; this file freezes what each command's `data`
 * member carries. The agent is the sole producer, the backend's RemoteLauncher
 * the sole consumer — but both sides validate, and this package is the shared
 * source of truth so the two tracks cannot drift. This file arrived
 * additively, changing no frozen frame, which the exact-match gate makes the
 * only kind of change there is: everything ships together, every frame change
 * bumps the version, and nothing has to be gated per agent. (The contract
 * history of the pre-restart numbering is in git; the numbering itself
 * restarted at 1 on 2026-09-09 — see `NODE_PROTOCOL_VERSION`.)
 *
 * `launch` / `terminate` / `kill` / `input` / `resize` / `tail_start` /
 * `tail_stop` / `remove_paths` / `inventory` / `ping` carry no data — their
 * success result is just `{ ok: true }`, so they need no validator here.
 *
 * Validators are hand-rolled in the `parseNodeEvent` style (this package stays
 * schema-lib-free); a NON-null return is safe to cast. The primitives the
 * validators stand on live in `guards.ts` (shared with `node-frames.ts`).
 */

import { BASE64_RE, isBool, isInt, isRecord, isStr, isStringMap } from "./guards.js";

function isNonEmptyStr(value: unknown): value is string {
  return isStr(value) && value.length > 0;
}

/* ------------------------------------------------------------------ */
/* probe                                                               */
/* ------------------------------------------------------------------ */

/** One row of a `probe` batch result (spec §6.3 reconcile: has-session + exit + title + optional capture). */
export interface NodeProbeEntry {
  /** subshell id this row describes */
  subshellId: string;
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
    if (!isRecord(e) || !isStr(e.subshellId) || !isBool(e.alive)) return null;
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
/* fs_ls                                                               */
/* ------------------------------------------------------------------ */

/** Cap on entries one `fs_ls` answer carries (the agent sets `truncated` at it). */
export const FS_LS_MAX_ENTRIES = 1000;

/**
 * `fs_ls` answer (remote folder picker): one directory level on
 * the node, mirroring the control plane's `GET /api/files/explore` payload so
 * the server can pass it through nearly unchanged. Success-only: missing /
 * unreadable / non-absolute targets answer `result{ok:false}` with an
 * `ENOENT:`/`EACCES:`/`EINVAL:` prefixed message the server maps to a
 * structured HTTP error. Directories only (the local route also reports files
 * but the picker renders nothing else), dotfiles hidden.
 */
export interface NodeFsLsResult {
  /** Absolute realpath of the listed directory on the node */
  path: string;
  /** Parent directory, null at the filesystem root (local-route parity) */
  parent: string | null;
  /** Direct-child directories, `name` + absolute `path`, capped at {@link FS_LS_MAX_ENTRIES} */
  entries: { name: string; path: string; kind: "dir" }[];
  /** True when the listing hit {@link FS_LS_MAX_ENTRIES} and stopped early */
  truncated: boolean;
}

/**
 * Validates and narrows an `fs_ls` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodeFsLsResult(data: unknown): NodeFsLsResult | null {
  if (!isRecord(data) || !isStr(data.path)) return null;
  if (!(data.parent === null || isStr(data.parent))) return null;
  if (!isBool(data.truncated)) return null;
  if (!Array.isArray(data.entries)) return null;
  for (const e of data.entries) {
    if (!isRecord(e) || !isStr(e.name) || !isStr(e.path) || e.kind !== "dir") return null;
  }
  return data as unknown as NodeFsLsResult;
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
/* detect                                                              */
/* ------------------------------------------------------------------ */

/**
 * One row of a `detect` answer (inversion spec §4): the cached inventory
 * entry's shape (`HarnessInventoryEntry`) with `version` replaced by
 * `rawVersion`. Raw is the whole point — the node has no plugin code, so it
 * cannot interpret `<binary> --version` output; the control plane parses the
 * text with the plugin and stores the ordinary entry. `checkedAt` keeps the
 * inventory entry's meaning ("when this was probed"); the agent handler does
 * not stamp it (the driver does), and the field is here so the wire mirrors
 * `HarnessInventoryEntry` rather than a parallel invention.
 *
 * A `type` alias for the same JsonValue reason as `SettingsFieldWire`.
 */
export type DetectResultWire = {
  /** Harness plugin id this row answers for (echo of the spec's `id`) */
  harnessId: string;
  /** Binary found and executable from this machine's perspective */
  installed: boolean;
  /** UNPARSED `<binary> --version` output when installed and readable */
  rawVersion?: string;
  /** Resolved binary path when installed */
  binaryPath?: string;
  /** Why the binary was not found; absent means the probe could not say */
  reason?: "not-on-path" | "override-invalid" | "no-binary";
  /** ISO 8601 stamp of when this entry was probed (the driver stamps it) */
  checkedAt?: string;
};

/**
 * A whole `detect` answer: one row per spec, plus the node's environment
 * values for the names the command asked about (spec 2026-09-10 §5 as amended
 * by the final review — the resume-path env moved from `ready` to this round
 * trip because the node holds no manifests and cannot know the names).
 */
export interface NodeDetectAnswer {
  /** Detection rows, one per spec */
  rows: DetectResultWire[];
  /**
   * Values ONLY for the asked names this node actually has — an absent key
   * means the variable is unset there, which is what triggers the plugin's
   * own fallback. `{}` is the ordinary answer when `envNames` was empty.
   */
  env: Record<string, string>;
}

/**
 * Validates and narrows a `detect` command's `result{data}` into its rows and
 * env answers. Both halves are REQUIRED: a node answers every `detect`, so an
 * answer missing `env` is a malformed payload, not a silent "no env".
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed answer, or null when the payload is malformed
 */
export function parseNodeDetectResults(data: unknown): NodeDetectAnswer | null {
  if (!isRecord(data) || !Array.isArray(data.results) || !isStringMap(data.env)) return null;
  for (const r of data.results) {
    if (!isRecord(r) || !isStr(r.harnessId) || !isBool(r.installed)) return null;
    if ("rawVersion" in r && !isStr(r.rawVersion)) return null;
    if ("binaryPath" in r && !isStr(r.binaryPath)) return null;
    if ("checkedAt" in r && !isStr(r.checkedAt)) return null;
    if ("reason" in r && r.reason !== "not-on-path" && r.reason !== "override-invalid" && r.reason !== "no-binary")
      return null;
  }
  return { rows: data.results as unknown as DetectResultWire[], env: data.env };
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

/** `path_exists` answer: whether the given path is there on the node. */
export interface NodePathExistsResult {
  /**
   * True when the stat-ed path exists. False is a SUCCESSFUL answer, not an
   * error: "the transcript is gone" is the ordinary half of a restart, and
   * the launcher reads an `ok:false` as a broken node instead.
   */
  exists: boolean;
}

/**
 * Validates and narrows a `path_exists` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodePathExistsResult(data: unknown): NodePathExistsResult | null {
  if (!isRecord(data) || !isBool(data.exists)) return null;
  return data as unknown as NodePathExistsResult;
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

/** A pane's real grid, as the agent measured it. */
export interface NodePaneSizeResult {
  /** Pane width in columns; always positive. */
  cols: number;
  /** Pane height in rows; always positive. */
  rows: number;
}

/**
 * Validates and narrows a `pane_size` command's `result{data}`.
 *
 * Three answers are all legal and mean different things, so the caller has to
 * be able to tell them apart:
 * - a grid — the pane holds exactly this;
 * - `null` data — the pane is gone (tmux could not be asked);
 * - a parse failure, also `null` here — an agent that answered nonsense.
 *
 * The last two collapse deliberately: both mean "no confirmed size", and the
 * control plane's only sane response to either is to announce nothing rather
 * than a guess. An agent too old to know the command never gets asked (see
 * `PANE_SIZE_MIN_PROTOCOL_VERSION`).
 *
 * @param data - the `data` member of a successful result frame
 * @returns the pane's grid, or null when absent/malformed
 */
export function parseNodePaneSizeResult(data: unknown): NodePaneSizeResult | null {
  if (!isRecord(data)) return null;
  const { cols, rows } = data as { cols?: unknown; rows?: unknown };
  // `isInt` is a type predicate, so both are `number` from here — no casts.
  if (!isInt(cols) || !isInt(rows)) return null;
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

/* ------------------------------------------------------------------ */
/* agent_log_read                                                      */
/* ------------------------------------------------------------------ */

/** A slice of the agent's own log file. */
export interface NodeAgentLogSlice {
  /** The bytes read, decoded as UTF-8. */
  text: string;
  /** Offset to pass as `fromByte` next time — the end of what was returned. */
  nextByte: number;
  /** The file's total size when it was read, so a caller can tell how far behind it is. */
  size: number;
  /**
   * True when `fromByte` pointed past the end of the file.
   *
   * The log is REPLACED when it hits its cap rather than rotated, so a reader
   * holding an offset from before a replacement is not merely behind — its
   * offset means nothing. This is the flag that tells it to start over instead
   * of reporting an empty tail forever.
   */
  truncated: boolean;
}

/**
 * Validates and narrows an `agent_log_read` result.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed slice, or null when the payload is malformed
 */
export function parseNodeAgentLogSlice(data: unknown): NodeAgentLogSlice | null {
  if (!isRecord(data)) return null;
  const { text, nextByte, size, truncated } = data;
  if (!isStr(text) || !isInt(nextByte) || !isInt(size) || !isBool(truncated)) return null;
  if (nextByte < 0 || size < 0) return null;
  return { text, nextByte, size, truncated };
}
