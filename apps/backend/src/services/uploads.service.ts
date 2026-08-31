import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sanitize from "sanitize-filename";
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
 * Deliberately carries no machine-readable code: the only consumer is the
 * upload route, which maps any `UploadError` to a 400 and returns `message`
 * verbatim. A discriminant existed here and drifted precisely because
 * nothing read it — add one back only alongside a caller that branches on it.
 */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = await fileTypeFromBuffer(bytes);
  const name = safeUploadName(file.name, sniffed?.ext ?? null, now);
  const dir = uploadsDirFor(workingRealPath);
  mkdirSync(dir, { recursive: true });
  const { path, finalName } = await writeUnique(workingRealPath, name, bytes);
  ensureGitExcluded(workingRealPath);
  return {
    path,
    name: finalName,
    size: bytes.byteLength,
    contentType: sniffed?.mime ?? file.type ?? "application/octet-stream",
  };
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
