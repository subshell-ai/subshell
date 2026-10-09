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

import { BASE64_RE, isBool, isInt, isRecord, isStr, isStrArray, isStringMap } from "./guards.js";
import { MAX_ARCHIVE_BYTES, MAX_MANIFEST_PAGE_ENTRIES } from "./node-frames.js";
import { parseSshConnectionSnapshot } from "./ssh-config.js";
import { isSshErrorCode } from "./ssh-errors.js";
import { isSshGrantFingerprint, isSshKnownHostsPinLine, isSshPaneId } from "./ssh-frames.js";
import {
  SSH_EXEC_RESULT_MAX_CHARS,
  SSH_MAX_DISCOVERED_ALIASES,
  SSH_MAX_HOST_KEY_LINES,
  SSH_NAME_MAX_CHARS,
  SSH_ROSTER_MAX_IDENTITIES,
} from "./ssh-limits.js";
import type {
  NodeSshAgentIdentitiesResult,
  NodeSshAgentIdentity,
  NodeSshAliasListResult,
  NodeSshExecKickResult,
  NodeSshExecStatusResult,
  NodeSshHostKeyResult,
  NodeSshIdentityResult,
  NodeSshMachinePinRepairResult,
  NodeSshResolveOutcomeWire,
} from "./ssh-results.js";

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
/* archive transfer (spec 2026-10-01 §2)                               */
/* ------------------------------------------------------------------ */

/** Lowercase-hex sha256 as the wire carries it: 64 chars, nothing else. */
function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * `archive_create` answer: the transport facts of the finished STAGING file.
 * The digest is over the compressed bytes because that is the exact span the
 * destination reassembles from `file_read` windows and re-verifies before
 * `archive_extract` touches anything.
 */
export interface NodeArchiveCreateResult {
  /** Byte size of the compressed staging archive. */
  size: number;
  /** Lowercase-hex sha256 of those compressed bytes. */
  sha256: string;
}

/**
 * Validates and narrows an `archive_create` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodeArchiveCreateResult(data: unknown): NodeArchiveCreateResult | null {
  // The ceiling is part of the shape, not a caller's policy: the relay plans
  // its loop by `size`, and a lying agent that reports 2^62 must not hand it
  // an unbounded plan (the writer-side cap is enforced at creation; this one
  // is the trust boundary on the way back).
  if (
    !isRecord(data) ||
    !isInt(data.size) ||
    (data.size as number) < 0 ||
    (data.size as number) > MAX_ARCHIVE_BYTES ||
    !isSha256Hex(data.sha256)
  )
    return null;
  return data as unknown as NodeArchiveCreateResult;
}

/**
 * `file_read` answer: the same window shape as {@link NodeLogReadResult}
 * (that reader's whole-file-size trick is what lets a relay plan its next
 * window), under its own name because the two commands' POLICIES differ and
 * a shared name would be the first step toward a shared code path.
 */
export type NodeFileReadResult = NodeLogReadResult;

/**
 * Validates and narrows a `file_read` command's `result{data}`. Same
 * invariants as {@link parseNodeLogReadResult}, checked by it; kept as its
 * own export so the relay code reads per-command.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed window, or null when malformed
 */
export function parseNodeFileReadResult(data: unknown): NodeFileReadResult | null {
  return parseNodeLogReadResult(data);
}

/**
 * `archive_extract` answer: what landed at the destination. Directories are
 * created but not counted; `bytes` is body bytes written, uncompressed.
 */
export interface NodeArchiveExtractResult {
  /** Regular files written. */
  files: number;
  /** Total body bytes written. */
  bytes: number;
}

/**
 * Validates and narrows an `archive_extract` command's `result{data}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed result, or null when malformed
 */
export function parseNodeArchiveExtractResult(data: unknown): NodeArchiveExtractResult | null {
  if (!isRecord(data) || !isInt(data.files) || (data.files as number) < 0) return null;
  if (!isInt(data.bytes) || (data.bytes as number) < 0) return null;
  return data as unknown as NodeArchiveExtractResult;
}

/**
 * One `tree_manifest` row: everything the plane needs to DIFF two trees.
 * `sha256` is the diff key; `mtime` is only a hint, and cross-machine clock
 * skew is why the key is not the timestamp.
 *
 * A `type` alias for the JsonValue reason as `SettingsFieldWire`.
 */
export type NodeManifestEntryWire = {
  /** Transfer-relative path (clean: no `..`, no leading slash), sorted. */
  relPath: string;
  /** Byte size at walk time. */
  size: number;
  /** mtime in whole seconds at walk time; a hint, never the diff key. */
  mtime: number;
  /** Lowercase-hex sha256 of the file's contents. */
  sha256: string;
};

/** One `tree_manifest` page. */
export interface NodeTreeManifestPage {
  /** Rows, relPath-sorted, at most {@link MAX_MANIFEST_PAGE_ENTRIES}. */
  entries: NodeManifestEntryWire[];
  /** Cursor for the next page, or null when the walk finished. */
  nextCursor: string | null;
}

/**
 * Validates and narrows a `tree_manifest` command's `result{data}`.
 *
 * `relPath` is checked for SHAPE here, not CLEANLINESS: the transfer path
 * guard lives in `pane-runtime` (`tar-blocks.ts`), and a protocol module
 * that imported it would weld the two together. The chain closes at use -
 * a plane that feeds these rows back as an `archive_create files[]` list
 * meets `safeTransferPath` inside `selectFiles`, so a hostile echoed
 * `relPath` is refused there, the same guard the extract path applies.
 *
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed page, or null when malformed
 */
export function parseNodeTreeManifestPage(data: unknown): NodeTreeManifestPage | null {
  if (!isRecord(data) || !Array.isArray(data.entries)) return null;
  if (data.entries.length > MAX_MANIFEST_PAGE_ENTRIES) return null;
  if (!(data.nextCursor === null || isNonEmptyStr(data.nextCursor))) return null;
  for (const e of data.entries) {
    if (!isRecord(e) || !isNonEmptyStr(e.relPath) || !isSha256Hex(e.sha256)) return null;
    if (!isInt(e.size) || (e.size as number) < 0) return null;
    if (!isInt(e.mtime) || (e.mtime as number) < 0) return null;
  }
  return data as unknown as NodeTreeManifestPage;
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
 * than a guess. An agent too old to know the command never gets asked: the
 * plane's EXACT-match gate (`NODE_PROTOCOL_VERSION`) refuses every agent that
 * does not share the current protocol, so any agent that receives this
 * command already speaks its answer.
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

/** The pane's cursor, in viewport coordinates (0-based, as tmux reports it). */
export interface NodePaneCursorResult {
  /** Column within the visible grid. */
  x: number;
  /** Row within the visible grid. */
  y: number;
}

/**
 * Validates and narrows a `pane_cursor` command's `result{data}`.
 *
 * Same three-answer grammar as {@link parseNodePaneSizeResult}: a cursor, a
 * legal null (pane gone), or a parse failure that collapses into null. Null
 * means the replay ships WITHOUT its cursor restore — the pre-`pane_cursor`
 * behavior, which is degraded for a cursor near the top of the grid and fine
 * everywhere the capture's last row is the cursor's row.
 *
 * @param data - the `data` member of a successful result frame
 * @returns the cursor, or null when absent/malformed
 */
export function parseNodePaneCursorResult(data: unknown): NodePaneCursorResult | null {
  if (!isRecord(data)) return null;
  const { x, y } = data as { x?: unknown; y?: unknown };
  if (!isInt(x) || !isInt(y)) return null;
  if (x < 0 || y < 0) return null;
  return { x, y };
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

/* ------------------------------------------------------------------ */
/* ssh discovery/resolution (the tier-1 wire types, dispatched from    */
/* here on)                                                            */
/* ------------------------------------------------------------------ */

/**
 * Validates and narrows an `ssh_discover_aliases` command's `result{data}`.
 * The list cap is part of the shape (same reasoning as the transfer page
 * cap): an answer past {@link SSH_MAX_DISCOVERED_ALIASES} is malformed here,
 * because the `truncated` flag is what the cap's existence depends on.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed list, or null when malformed
 */
export function parseNodeSshAliasList(data: unknown): NodeSshAliasListResult | null {
  if (!isRecord(data) || !isBool(data.includeCycle) || !isBool(data.truncated)) return null;
  if (!isStrArray(data.aliases) || (data.aliases as string[]).length > SSH_MAX_DISCOVERED_ALIASES) return null;
  return { aliases: [...(data.aliases as string[])], includeCycle: data.includeCycle, truncated: data.truncated };
}

/**
 * Validates and narrows an `ssh_resolve_config` command's `result{data}`.
 * The accepted arm runs the FULL snapshot validator: a resolve answer is the
 * one moment an unvalidated snapshot could enter the system, so this is where
 * the plane's copy gets its grammar checked before it is stored.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed outcome, or null when malformed
 */
export function parseNodeSshResolveOutcome(data: unknown): NodeSshResolveOutcomeWire | null {
  if (!isRecord(data) || !isBool(data.accepted)) return null;
  if (data.accepted) {
    const snapshot = parseSshConnectionSnapshot(data.snapshot);
    if (!snapshot) return null;
    if ("connectingAccount" in data && !isStr(data.connectingAccount)) return null;
    return {
      accepted: true,
      snapshot,
      ...("connectingAccount" in data ? { connectingAccount: data.connectingAccount as string } : {}),
    };
  }
  if (!isSshErrorCode(data.code) || !isStrArray(data.settings)) return null;
  return { accepted: false, code: data.code, settings: [...(data.settings as string[])] };
}

/**
 * Validates and narrows an `ssh_agent_identities` command's `result{data}`
 * (spec 2026-10-08 §5.4, Task 11). The BLOBS are unrepresentable by
 * construction: each entry is REBUILT from its two checked fields, so a
 * `blob` member a buggy or hostile node tried to ship drops here and the
 * narrowed answer has nowhere to hold key material. Fingerprints must be in
 * the grant grammar's own spelling (one predicate, both directions: the
 * approve surface takes roster values verbatim); comments are OpenSSH's
 * labels, passed through as bounded text, never parsed. The entry COUNT is
 * capped at {@link SSH_ROSTER_MAX_IDENTITIES} rather than truncated (the
 * same reasoning {@link SSH_MAX_HOST_KEY_LINES} carries): a past-cap roster
 * is a malformed machine, and an answer quietly cut to size would read to
 * the operator as the agent's whole truth.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed roster, or null when malformed
 */
export function parseNodeSshAgentIdentities(data: unknown): NodeSshAgentIdentitiesResult | null {
  if (!isRecord(data) || !Array.isArray(data.identities)) return null;
  if (data.identities.length > SSH_ROSTER_MAX_IDENTITIES) return null;
  const identities: NodeSshAgentIdentity[] = [];
  for (const entry of data.identities as unknown[]) {
    if (!isRecord(entry) || !isSshGrantFingerprint(entry.fingerprint)) return null;
    if (!isStr(entry.comment) || entry.comment.length > SSH_NAME_MAX_CHARS) return null;
    identities.push({ fingerprint: entry.fingerprint, comment: entry.comment });
  }
  return { identities };
}

/**
 * Validates and narrows an `ssh_host_key` command's `result{data}` (spec
 * 2026-10-08 §9, Task 12). Each line is checked with the SAME predicate that
 * gates the relay-open's pin carriage ({@link isSshKnownHostsPinLine}) - one
 * definition of "what a wire host-key line is", answer in and pin out, so a
 * line A answered can always ride the open that carries it - and the answer
 * is capped at {@link SSH_MAX_HOST_KEY_LINES} rather than truncated (the
 * roster cap's reasoning: a past-cap answer is a malformed machine, not a
 * long one). An empty list parses: "A has recorded nothing" is the fact the
 * capture fails closed on, and a fabrication-shaped error would hide it.
 * Deep well-formedness (which token is the key, whether it matches D) is the
 * capture service's fingerprint extraction and B's OpenSSH at connect time.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed entries, or null when malformed
 */
export function parseNodeSshHostKey(data: unknown): NodeSshHostKeyResult | null {
  if (!isRecord(data) || !Array.isArray(data.lines)) return null;
  if ((data.lines as unknown[]).length > SSH_MAX_HOST_KEY_LINES) return null;
  const lines: string[] = [];
  for (const line of data.lines as unknown[]) {
    if (!isSshKnownHostsPinLine(line)) return null;
    lines.push(line);
  }
  return { lines };
}

/**
 * Validates and narrows an `ssh_register_identity` command's `result{data}`
 * (spec 2026-10-08 §4.3). Deliberately shallow: the grammar proves the field
 * is a non-empty string carrying JSON that parses to an object. ES256
 * importability (and the no-private-component rule) is the server's gate at
 * the store, not the wire's; a machine answering its OWN key has nothing to
 * inject beyond its own identity.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed answer, or null when malformed
 */
export function parseNodeSshIdentity(data: unknown): NodeSshIdentityResult | null {
  if (!isRecord(data) || !isNonEmptyStr(data.signingPublicKey)) return null;
  try {
    if (!isRecord(JSON.parse(data.signingPublicKey) as unknown)) return null;
  } catch {
    return null;
  }
  return { signingPublicKey: data.signingPublicKey };
}

/**
 * Validates and narrows the ack of an `ssh_machine_pin_repair` (spec
 * 2026-10-08 §4.5, Task 17). Two fields and no opinion: `repaired: true` is
 * the ONLY legal value (a machine that refused the write answers `ok:false`
 * with the named cause, the exec-kick posture restated), and the peer id is
 * the echo the plane matches its act against by equality. Nothing else may
 * ride it - the answer structurally has no slot for key material, and the
 * durable record of the act is the plane's ids-only audit row, not this ack.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed ack, or null when malformed
 */
export function parseNodeSshMachinePinRepair(data: unknown): NodeSshMachinePinRepairResult | null {
  if (!isRecord(data)) return null;
  if (data.repaired !== true) return null;
  if (!isNonEmptyStr(data.peerNodeId)) return null;
  return { repaired: true, peerNodeId: data.peerNodeId };
}

/**
 * Validates and narrows an `ssh_exec` KICK's `result{data}` (spec 2026-10-08
 * §7, Task 14). The ack is two fields and no opinion: a machine that did not
 * start answers `ok:false` (a refusal), never a `{started:false}`.
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed ack, or null when malformed
 */
export function parseNodeSshExecKick(data: unknown): NodeSshExecKickResult | null {
  if (!isRecord(data)) return null;
  if (data.started !== true) return null;
  if (!isSshPaneId(data.execId)) return null;
  return { started: true, execId: data.execId };
}

/**
 * Validates and narrows an `ssh_exec_status` answer (spec 2026-10-08 §7,
 * Task 14). Two closed states, and `done` states ALL FOUR facts (a code, a
 * timeout flag, and both streams): a machine answering half the outcome
 * would let the plane guess which half the installer broke on. The streams
 * are bounded printable text - newlines, tabs, and CR survive; every other
 * control character refuses the answer (an escape sequence reaching a
 * renderable field is not "output", and the plane re-redacts anyway).
 * @param data - the `data` member of a successful result frame
 * @returns the narrowed status, or null when malformed
 */
export function parseNodeSshExecStatus(data: unknown): NodeSshExecStatusResult | null {
  if (!isRecord(data)) return null;
  if (data.state === "running") {
    // Running is running: nothing may ride it (a smuggled half-outcome would
    // be exactly the partial truth the "done states all four" rule refuses).
    if (Object.keys(data).length !== 1) return null;
    return { state: "running" };
  }
  if (data.state !== "done") return null;
  if (!("code" in data) || !(data.code === null || isInt(data.code))) return null;
  if (!isBool(data.timedOut)) return null;
  if (!isExecStreamStr(data.stdout) || !isExecStreamStr(data.stderr)) return null;
  return {
    state: "done",
    code: data.code === null ? null : (data.code as number),
    timedOut: data.timedOut,
    stdout: data.stdout,
    stderr: data.stderr,
  };
}

/** A captured stream: bounded text whose only control characters are newlines, tabs, and CR. */
function isExecStreamStr(value: unknown): value is string {
  if (!isStr(value) || value.length > SSH_EXEC_RESULT_MAX_CHARS) return false;
  return !/\p{Cc}/u.test(value.replace(/[\n\r\t]/g, ""));
}
