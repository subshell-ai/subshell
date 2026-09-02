import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { parseNodeWriteFileResult } from "@internal/session-protocol";
import { fileTypeFromBuffer } from "file-type";
import sanitize from "sanitize-filename";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/** Upper bound on collision-suffix retries before giving up. */
const MAX_COLLISION_ATTEMPTS = 1000;

/** Directory (relative to the working directory) that holds Mote's per-directory state. */
const MOTE_DIR = ".mote";

/** The single line appended to .git/info/exclude. */
const GIT_EXCLUDE_LINE = `${MOTE_DIR}/`;

/** Filesystem limit for a single path component. */
const MAX_NAME_BYTES = 255;

/**
 * Upper bound on the extension length. A real extension is a handful of
 * characters; this exists so a pathologically long (or attacker-supplied)
 * "extension" can never by itself push the final name over
 * {@link MAX_NAME_BYTES}, no matter how the stem is trimmed.
 */
const MAX_EXT_BYTES = 32;

/** Result of a successful upload. */
export interface UploadResult {
  /** Absolute path the harness can read the file at */
  path: string;
  /** Final on-disk filename (sanitized, timestamp-prefixed) */
  name: string;
  /** Size in bytes */
  size: number;
  /** MIME type, sniffed from content when possible, else the client's */
  contentType: string;
}

/**
 * An upload that cannot be stored safely.
 *
 * Deliberately carries no machine-readable code: the local upload path maps
 * any `UploadError` to a 400 and returns `message` verbatim. A discriminant
 * existed here and drifted precisely because nothing read it — add one back
 * only alongside a caller that branches on it. (The remote relay needs a
 * discriminant for exactly that reason, so it got one — on
 * {@link RemoteUploadError}, leaving this class's contract untouched.)
 */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * An upload that was relayed to an agent node and failed on the wire or on
 * the node itself — the remote twin of {@link UploadError}.
 *
 * This class DOES carry the one discriminant the upload route branches on
 * (`offline`, deciding NODE_OFFLINE vs NODE_UNREACHABLE — both 409):
 * unlike the base class's "nothing reads a
 * code" situation, here a caller genuinely branches, and it branches on
 * `instanceof` + a boolean — never on message text, because agent error
 * strings are deliberately unpinned protocol-side (T6 ruling).
 */
export class RemoteUploadError extends UploadError {
  /**
   * True when the node's connection was gone when a chunk was sent — the
   * §5.6 NODE_OFFLINE class (mid-stream disconnect). Every other failure
   * (refusal, timeout, malformed answer, short `received`) is false.
   */
  readonly offline: boolean;

  constructor(message: string, offline = false) {
    super(message);
    this.name = "RemoteUploadError";
    this.offline = offline;
  }
}

/**
 * The uploads directory for a working directory.
 *
 * Uploads are keyed by working directory, not by session: `restart` mints a new
 * session id for the same directory, and a transcript may be reopened much
 * later, so a session-scoped directory would break every path in it.
 *
 * @param workingRealPath - Resolved absolute working directory
 * @returns Absolute path of the uploads directory
 */
export function uploadsDirFor(workingRealPath: string): string {
  return join(workingRealPath, MOTE_DIR, "uploads");
}

/**
 * Derives a safe, collision-resistant filename.
 *
 * Beyond stripping traversal and control characters, this guarantees the
 * result contains no whitespace — the path is injected into an agent prompt
 * (not a shell), where quoting would be wrong, so a space-free name is what
 * makes a space-joined list of paths unambiguous.
 *
 * @param rawName - Client-supplied filename (may be empty or hostile)
 * @param sniffedExt - Extension detected from the file's magic bytes, if any
 * @param now - Timestamp source for the prefix
 * @returns A filename of the form `YYYYMMDD-HHmmss-name.ext`
 */
export function safeUploadName(rawName: string, sniffedExt: string | null, now: Date): string {
  // basename first so a traversal attempt cannot survive as a path.
  const base = basename(rawName ?? "");
  const rawExt = extname(base);
  const rawStem = base.slice(0, base.length - rawExt.length);

  // Sanitize the stem and extension independently. sanitize-filename blanks
  // an entire Windows-reserved name (e.g. "CON"), and if that ran before the
  // split, a legitimate file like "aux.log" would lose its extension along
  // with the reserved stem.
  let stem = sanitize(rawStem).trim();
  // Collapse whitespace, then drop anything outside the safe charset.
  stem = stem.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  // Leading dots would make the upload a hidden file (or "..").
  stem = stem.replace(/^\.+/, "");

  let ext = sanitize(rawExt.replace(/^\./, ""))
    .trim()
    .replace(/[^A-Za-z0-9]/g, "");
  if (sniffedExt) ext = sniffedExt;
  if (!stem) stem = "pasted";
  // Cap the extension too: without this, a pathologically long "extension"
  // (everything after the last dot) could alone exceed the name limit even
  // after the stem below is trimmed to nothing.
  if (ext.length > MAX_EXT_BYTES) ext = ext.slice(0, MAX_EXT_BYTES);

  const prefix = timestampPrefix(now);
  const suffix = ext ? `.${ext}` : "";
  // Trim the stem (never the prefix) to fit the name limit.
  const budget = MAX_NAME_BYTES - prefix.length - suffix.length;
  if (stem.length > budget) stem = stem.slice(0, Math.max(1, budget));
  return `${prefix}${stem}${suffix}`;
}

/**
 * Resolves a sanitized filename inside a working directory's uploads directory.
 *
 * Re-verifies containment after resolution: defense in depth behind
 * {@link safeUploadName}, so a sanitization gap can never write outside the
 * working directory.
 *
 * @param workingRealPath - Resolved absolute working directory
 * @param name - Already-sanitized filename
 * @returns Absolute path inside the uploads directory
 * @throws UploadError when the resolved path escapes the working directory
 */
export function resolveUploadPath(workingRealPath: string, name: string): string {
  if (!name || isAbsolute(name)) {
    throw new UploadError("Upload name must be a bare filename");
  }
  const dir = uploadsDirFor(workingRealPath);
  const full = resolve(dir, name);
  if (full !== join(dir, basename(full)) || !full.startsWith(dir + sep)) {
    throw new UploadError("Upload path escapes the working directory");
  }
  return full;
}

/**
 * Appends `.mote/` to the working directory's `.git/info/exclude` when missing.
 *
 * `info/exclude` rather than `.gitignore`: it is per-clone and untracked, so
 * Mote never modifies a file the user commits. Best-effort — an unwritable
 * git dir must not fail an upload.
 *
 * @param workingRealPath - Resolved absolute working directory
 */
export function ensureGitExcluded(workingRealPath: string): void {
  try {
    const gitDir = join(workingRealPath, ".git");
    if (!existsSync(gitDir)) return;
    const infoDir = join(gitDir, "info");
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
    const excludeFile = join(infoDir, "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === GIT_EXCLUDE_LINE)) return;
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    appendFileSync(excludeFile, `${prefix}${GIT_EXCLUDE_LINE}\n`);
  } catch (err) {
    // Never block an upload on git bookkeeping, but a permanently failing
    // exclude write should be visible somewhere rather than silent.
    logger.withError(err).warn(`failed to update .git/info/exclude for ${workingRealPath}`);
  }
}

/** What {@link sniffedUpload} derives from a `File` before any storage exists. */
export interface SniffedUpload {
  /** Owned copy of the file's bytes (safe to slice for chunking) */
  bytes: Uint8Array;
  /** Final sanitized, timestamp-prefixed filename */
  name: string;
  /** MIME type, sniffed from content when possible, else the client's */
  contentType: string;
}

/**
 * Reads, magic-sniffs and names an uploaded file — the storage-agnostic head
 * of {@link writeUpload}, shared verbatim by the remote relay.
 *
 * Sniff ordering is load-bearing and preserved here: the magic check runs on
 * the real bytes BEFORE `safeUploadName` (the sniffed extension wins over the
 * client's), and the content type falls back client-type → octet-stream, just
 * as the local write always did.
 *
 * @param file - The uploaded file
 * @param now - Timestamp source for the filename prefix (defaults to now)
 * @returns The bytes, the safe name and the derived content type
 */
export async function sniffedUpload(file: File, now = new Date()): Promise<SniffedUpload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = await fileTypeFromBuffer(bytes);
  return {
    bytes,
    name: safeUploadName(file.name, sniffed?.ext ?? null, now),
    contentType: sniffed?.mime ?? file.type ?? "application/octet-stream",
  };
}

/**
 * Stores an uploaded file in the working directory and returns its absolute path.
 *
 * @param args.workingRealPath - Resolved absolute working directory
 * @param args.file - The uploaded file
 * @param args.now - Timestamp source for the filename prefix (defaults to now)
 * @returns Path, final name, size and content type of the stored file
 * @throws UploadError when no safe path can be derived
 */
export async function writeUpload({
  workingRealPath,
  file,
  now = new Date(),
}: {
  workingRealPath: string;
  file: File;
  now?: Date;
}): Promise<UploadResult> {
  const { bytes, name, contentType } = await sniffedUpload(file, now);
  const dir = uploadsDirFor(workingRealPath);
  mkdirSync(dir, { recursive: true });
  const { path, finalName } = await writeUnique(workingRealPath, name, bytes);
  ensureGitExcluded(workingRealPath);
  return { path, name: finalName, size: bytes.byteLength, contentType };
}

/* ------------------------------------------------------------------ */
/* remote relay (spec 2026-08-31 §3.4, phase-2 Task 12)                */
/* ------------------------------------------------------------------ */

/**
 * Raw byte budget per `write_file` frame. 512 KiB, NOT the spec prose's
 * 768 KiB: base64 inflates by 4/3, so 768 KiB raw overflows the 1 MiB frame
 * cap (spec errata — Global Constraints pin this value).
 */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;

/** Per-chunk RPC deadline — parity with RemoteLauncher's `write_file` budget. */
const WRITE_CHUNK_TIMEOUT_MS = 30_000;

/**
 * The ONE budget-disciplined name tagger behind every collision suffix:
 * splits `name` on its last dot (extension re-capped to
 * {@link MAX_EXT_BYTES}, defense in depth — not every caller pre-bounds it)
 * and inserts `tag` before the extension, trimming the STEM — never the
 * prefix or the tag — so the result fits {@link MAX_NAME_BYTES}. The suffix
 * replaces stem bytes rather than pushing a maximal name past the limit.
 * @param name - The base (sanitized, usually timestamp-prefixed) filename
 * @param tag - The collision tag, including its leading `-`
 */
function suffixedName(name: string, tag: string): string {
  const rawExt = extname(name);
  const stem = name.slice(0, name.length - rawExt.length);
  const extBody = rawExt.replace(/^\./, "").slice(0, MAX_EXT_BYTES);
  const ext = extBody ? `.${extBody}` : "";
  const budget = MAX_NAME_BYTES - tag.length - ext.length;
  const trimmedStem = stem.length > budget ? stem.slice(0, Math.max(1, budget)) : stem;
  return `${trimmedStem}${tag}${ext}`;
}

/**
 * Collision-safety stand-in for local {@link writeUnique} on the remote relay.
 *
 * The agent receiver overwrites by contract (a second-granularity
 * timestamp-prefixed name reused within one second silently replaces the
 * first upload), and the relay cannot see node-side collisions to suffix
 * around them, so it appends `-<8 hex>` before the extension instead.
 * 8 hex chars is plenty at human upload rates; name shape stays
 * timestamp-prefixed so recents still sort.
 *
 * Budget discipline via {@link suffixedName} (shared with {@link withSuffix}):
 * the tag replaces stem bytes rather than pushing a maximal name past
 * {@link MAX_NAME_BYTES}.
 *
 * @param name - The sanitized, timestamp-prefixed base name from {@link safeUploadName}
 * @returns The same name with a random `-<8hex>` tag before the extension
 */
export function remoteUniqueName(name: string): string {
  return suffixedName(name, `-${randomUUID().slice(0, 8)}`);
}

/**
 * Relays an uploaded file to an agent node as ordered `write_file` chunks
 * (spec §3.4) and returns the path ON THE NODE.
 *
 * The composition is string-only — no local `mkdirSync`, no `resolveUploadPath`
 * containment check, no {@link ensureGitExcluded}: the target lives on the
 * node's filesystem, where the agent's own twice-gated path policy
 * (`apps/agent/src/commands/write-file.ts`) is the authority and git
 * bookkeeping stays operator-controlled.
 *
 * Agent-side semantics this loop relies on (pinned by the agent's own tests):
 * - chunk indices must arrive strictly 0, 1, 2… — every chunk is AWAITED
 *   before the next is sent, and any failure stops the loop immediately (no
 *   further frames, eof included).
 * - every accepted chunk answers `{ path, received }` with `received` the
 *   running total; the eof answer MUST equal the file size or this throws.
 * - `chunk 0` on an open stream REPLACES it, so re-running the upload from
 *   chunk 0 recovers any TRANSIENT failure — deliberately no abort command,
 *   and the short-`received` throw below needs no cleanup (the agent's
 *   `.part` tmp is replaced on the next attempt). Not a promise for the
 *   common refusal: a session whose pane exited NATURALLY is `meta.forget`-ed
 *   by the agent's exit watcher, its cwd leaves the write_file root set, and
 *   re-running can never succeed — relaunch the session (spec errata,
 *   phase-2 review #7).
 * - refusals (`ok:false`, e.g. policy) surface as `NodeRpcError("failed")`
 *   whose message is UNPINNED protocol-side — it rides the
 *   {@link RemoteUploadError} for the logs but the route must map on the
 *   class/flag only, never on the text.
 *
 * A zero-byte file still sends one empty eof chunk so the node-side file
 * exists (local parity: `writeUpload` creates empty files too).
 *
 * @param nodeId - Target node (caller has already gated on a live connection;
 *   a mid-stream drop maps to `offline: true`)
 * @param workingRealPath - The session's working directory AS THERE (absolute)
 * @param file - The uploaded file
 * @returns Path (on the node), final name, size and content type
 * @throws UploadError when the composed target is not an absolute path —
 *   checked BEFORE the first frame: the agent echoes the path it was given,
 *   and an empty/garbage echo wedges the result mapping (T6 finding #4)
 * @throws RemoteUploadError for any wire/agent failure
 */
export async function writeUploadRemote(nodeId: string, workingRealPath: string, file: File): Promise<UploadResult> {
  const { bytes, name: baseName, contentType } = await sniffedUpload(file);
  // The agent's eof rename replaces an existing file, and two uploads inside
  // one second otherwise share the timestamp-prefixed name — suffix before
  // composing the target so a collision becomes two files, not one lost file.
  const name = remoteUniqueName(baseName);
  const path = `${uploadsDirFor(workingRealPath)}/${name}`;
  if (!name || !path.startsWith("/")) {
    throw new UploadError("Upload target must be an absolute path on the node");
  }
  logger.debug(
    `remote upload to node "${nodeId}": ${bytes.byteLength} bytes -> ${path} (git-exclude skipped — node-side git is operator-controlled)`,
  );

  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / UPLOAD_CHUNK_BYTES));
  let received = 0;
  for (let i = 0; i < chunkCount; i++) {
    const off = i * UPLOAD_CHUNK_BYTES;
    const piece = bytes.subarray(off, Math.min(off + UPLOAD_CHUNK_BYTES, bytes.byteLength));
    let data: unknown;
    try {
      data = await sendCommand(
        nodeId,
        {
          type: "write_file",
          path,
          // Zero-copy view of the slice (`piece` is a `bytes.subarray` view) —
          // `Buffer.from(uint8array)` would clone the whole chunk first.
          chunk_b64: Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString("base64"),
          chunk: i,
          eof: i === chunkCount - 1,
        },
        WRITE_CHUNK_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof NodeRpcError) {
        throw new RemoteUploadError(
          `write_file chunk ${i} to node "${nodeId}" failed: ${err.message}`,
          err.code === "offline",
        );
      }
      throw err;
    }
    const result = parseNodeWriteFileResult(data);
    if (!result) throw new RemoteUploadError(`node "${nodeId}" returned a malformed write_file result (chunk ${i})`);
    received = result.received;
    if (i === chunkCount - 1 && received !== bytes.byteLength) {
      throw new RemoteUploadError(`node "${nodeId}" received ${received} of ${bytes.byteLength} bytes`);
    }
  }
  return { path, name, size: bytes.byteLength, contentType };
}

/** `YYYYMMDD-HHmmss-` in UTC. */
function timestampPrefix(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-`;
}

/**
 * Writes `bytes` under a free name, suffixing `-2`, `-3`, … on collision.
 *
 * Uses an exclusive-create write (`wx`) rather than check-then-write:
 * `existsSync` followed by an awaited write left a window where two
 * concurrent uploads resolving to the same candidate could both pass the
 * check before either file landed, silently clobbering one payload. `wx`
 * makes the check and the write a single atomic filesystem operation, so a
 * collision surfaces as `EEXIST` instead of a lost file.
 *
 * @param workingRealPath - Resolved absolute working directory
 * @param name - Candidate filename (already timestamp-prefixed and sanitized)
 * @param bytes - File contents to write
 * @returns The path actually written to and its final (possibly suffixed) name
 * @throws UploadError if no free name is found within {@link MAX_COLLISION_ATTEMPTS} attempts
 */
async function writeUnique(
  workingRealPath: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string; finalName: string }> {
  let candidate = name;
  let attempt = 1;
  for (;;) {
    const path = resolveUploadPath(workingRealPath, candidate);
    try {
      await writeFile(path, bytes, { flag: "wx" });
      return { path, finalName: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      attempt += 1;
      if (attempt > MAX_COLLISION_ATTEMPTS) {
        throw new UploadError("Too many name collisions while storing upload");
      }
      candidate = withSuffix(name, attempt);
    }
  }
}

/**
 * Appends `-n` before the extension, truncating the stem so the result
 * still fits {@link MAX_NAME_BYTES} — the suffix must fit within the
 * existing length budget, not be tacked on top of an already-maximal name.
 *
 * @param name - The unsuffixed candidate name
 * @param n - Collision counter (2, 3, …)
 * @returns A filename of the form `stem-n.ext`, length-bounded
 */
function withSuffix(name: string, n: number): string {
  const rawExt = extname(name);
  const stem = name.slice(0, name.length - rawExt.length);
  // Re-cap the extension here too (defense in depth, same reasoning as
  // safeUploadName): don't assume every caller already bounded it.
  const extBody = rawExt.replace(/^\./, "").slice(0, MAX_EXT_BYTES);
  const ext = extBody ? `.${extBody}` : "";
  const suffixTag = `-${n}`;
  const budget = MAX_NAME_BYTES - suffixTag.length - ext.length;
  const trimmedStem = stem.length > budget ? stem.slice(0, Math.max(1, budget)) : stem;
  return `${trimmedStem}${suffixTag}${ext}`;
}
