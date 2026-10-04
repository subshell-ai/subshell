/**
 * Streaming, guarded ustar/pax tar.gz EXTRACTOR for node-to-node archive
 * transfer (spec 2026-10-01 §3). Built on tar-blocks.ts; the matched reader
 * for tar-writer.ts. Decompresses with node:zlib's createGunzip and writes file
 * bodies to disk incrementally, so it never holds more than ~one chunk plus the
 * sub-block tar remainder in memory - the counterpart to the writer's
 * streaming property.
 *
 * Security posture (the reason extraction is the load-bearing half of this
 * feature):
 *   - every entry path is policed by safeTransferPath AFTER any pax override,
 *     so a long-name archive cannot smuggle `..` or an absolute path past the
 *     fixed-field value the writer put there;
 *   - the destination is the filesystem surface, so it is enforced on the
 *     filesystem too: everything lands under the realpath'd `destRoot`, every
 *     created path component is checked to be a real DIRECTORY (a symlinked
 *     ancestor is refused), a file leaf is opened with O_NOFOLLOW, and a leaf
 *     with more than one name (a HARD link out) is refused before its own
 *     ftruncate runs - a hard link is a plain regular file to open(), invisible
 *     to O_NOFOLLOW, and O_TRUNC-at-open would have punched through the shared
 *     inode before any check could see it. A valid archive naming `sub/victim`
 *     must not write through a `destRoot/sub -> /outside` symlink that pre-dated
 *     the transfer - the lexical guard sees a clean relative name and cannot;
 *     only the lstat/O_NOFOLLOW/nlink discipline does;
 *   - only regular files and directories are accepted; symlinks, hardlinks,
 *     devices, FIFOs and any other typeflag are refused outright;
 *   - per-file, total and entry caps run DURING the pass, and a pax header's
 *     declared body size is bounded BEFORE it is allocated, so neither a lying
 *     file size nor a lying metadata size can exhaust the destination;
 *   - each file takes its recorded mode (via fchmod, so an OVERWRITTEN file
 *     re-adopts the source's permissions too, not only a freshly-created one)
 *     and, unless it is the writer's 0 "unstated" default, its recorded mtime;
 *     the extractor never deletes anything (additive by ruling).
 *
 * The transport sha256 is verified by the CALLER before this runs (against the
 * digest archive_create reported), so extract trusts only that the bytes are
 * what the source wrote, not that they are benign - benign-ness is these
 * guards' job, and a verified digest proves identity, not safety.
 */

import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import {
  BLOCK,
  blockPadding,
  isZeroBlock,
  parseHeader,
  paxOverridePath,
  safeTransferPath,
  TYPE_DIR,
  TYPE_FILE,
  TYPE_PAX,
} from "./tar-blocks.js";
import type { ArchiveLimits } from "./tar-writer.js";

/**
 * Ceiling on a single pax extended/global header BODY, enforced before the
 * declared size is allocated. The writer emits a pax record only to carry a
 * `path=` override (a long name plus a handful of fixed fields), so a legal
 * record is a few hundred bytes; this bound exists purely to stop a hostile
 * archive naming a multi-gigabyte metadata body that `takeBytes` would
 * allocate in full before any cap could see it. Well above any real record,
 * far below an allocation that could exhaust the destination.
 */
const MAX_PAX_METADATA_BYTES = 64 * 1024;

/** What one extract wrote, for the `archive_extract` command answer. */
export interface ExtractResult {
  /** Regular files written (directories are created but not counted). */
  files: number;
  /** Total body bytes written. */
  bytes: number;
}

/**
 * Extract the gzip archive at `archivePath` into `destRoot`, streaming.
 * Throws naming the refused entry, the violated cap, or truncation. Creates
 * parent directories as needed. Returns the file/byte totals.
 */
export async function extractTarGz(
  archivePath: string,
  destRoot: string,
  limits: ArchiveLimits,
): Promise<ExtractResult> {
  const gunzip = createGunzip();
  const pump = createReadStream(archivePath);
  pump.on("error", (e) => gunzip.destroy(e));
  pump.pipe(gunzip);
  const it = (gunzip as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();

  // The decompressed remainder not yet consumed. Kept small: headers read
  // whole blocks, bodies stream to disk, so this stays under one chunk.
  // Typed as the default Uint8Array (ArrayBufferLike): zlib stream chunks
  // carry a plain ArrayBuffer and a SharedArrayBuffer-capable target keeps
  // both chunk spellings assignable.
  let buf: Uint8Array = new Uint8Array(0);
  let files = 0;
  let bytes = 0;
  let entries = 0;
  let metaTotal = 0; // pax/global bodies, accounted separately from file bodies
  let pendingPath: string | undefined;

  // The destination's REAL location, resolved once. It may not exist yet (the
  // first copy onto a fresh dir), so create it first; a symlinked root the
  // operator allowlisted resolves to where it actually writes. Every component
  // created below this is checked to be a real directory, so nothing a transfer
  // lands can traverse OUT of it through a symlink that was already there.
  mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  const realDest = realpathSync(destRoot);

  const more = async (): Promise<boolean> => {
    const { value, done } = await it.next();
    if (done) return false;
    buf = buf.length === 0 ? (value as Uint8Array) : concat(buf, value as Uint8Array);
    return true;
  };
  const need = async (n: number): Promise<boolean> => {
    while (buf.length < n) if (!(await more())) return false;
    return true;
  };
  const takeBytes = async (n: number): Promise<Uint8Array> => {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      if (buf.length === 0 && !(await more())) throw new Error("tar: truncated archive (body)");
      const w = Math.min(n - off, buf.length);
      out.set(buf.subarray(0, w), off);
      buf = buf.subarray(w);
      off += w;
    }
    return out;
  };
  const skipBytes = async (n: number): Promise<void> => {
    let remaining = n;
    while (remaining > 0) {
      if (buf.length === 0 && !(await more())) throw new Error("tar: truncated archive (padding)");
      const w = Math.min(remaining, buf.length);
      buf = buf.subarray(w);
      remaining -= w;
    }
  };

  // Refuse a symlinked destination component, and require a directory where one
  // is needed. `lstat` (not `stat`) so a symlink is seen as itself and rejected,
  // never followed; a missing component is created as a 0700 real directory.
  const ensureRealDir = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      mkdirSync(p, { mode: 0o700 });
      try {
        chmodSync(p, 0o700); // mkdir's mode is umask-masked; a fresh dir we own is 0700
      } catch {
        // a filesystem without chmod support still has the umask-shaped dir
      }
      st = lstatSync(p);
    }
    if (st.isSymbolicLink()) throw new Error(`tar: refusing symlinked destination '${p}'`);
    if (!st.isDirectory()) throw new Error(`tar: destination component is not a directory '${p}'`);
  };

  // Create/verify the first `upto` path segments (of a safeTransferPath-clean
  // rel) as contained real directories, and return the directory that holds the
  // leaf (or the leaf itself when `upto` covers every segment, the dir-entry
  // case). `segs` has no `.`/`..`/empty by construction (safeTransferPath).
  const ensureDirChain = (segs: string[], upto: number): string => {
    let cur = realDest;
    for (let i = 0; i < upto; i++) {
      cur = join(cur, segs[i]!);
      ensureRealDir(cur);
    }
    return cur;
  };

  try {
    for (;;) {
      if (!(await need(BLOCK))) break; // clean EOF without an explicit terminator
      const headerBlock = buf.subarray(0, BLOCK);
      if (isZeroBlock(headerBlock)) break;
      buf = buf.subarray(BLOCK);
      const h = parseHeader(headerBlock);

      if (h.typeflag === TYPE_PAX || h.typeflag === "g") {
        // Bound the DECLARED metadata size before allocating a buffer for it,
        // and account it against the total cap: a verified digest makes the
        // source genuine, not safe, so a hostile archive naming a gigabyte
        // pax body must be refused here, not allocated first.
        if (h.size > MAX_PAX_METADATA_BYTES)
          throw new Error(`tar: pax metadata body of ${h.size} exceeds the ${MAX_PAX_METADATA_BYTES}-byte cap`);
        if (metaTotal + h.size > limits.maxTotalBytes)
          throw new Error(`tar: archive metadata exceeds the ${limits.maxTotalBytes}-byte total`);
        metaTotal += h.size;
        const body = await takeBytes(h.size);
        // Only a per-entry ("x") record may carry the path override. POSIX
        // keeps `path` out of global records, so a "g" naming one is hostile
        // or broken: honoring it would let the record rename whichever entry
        // follows it. Its body is still read, accounted, and skipped.
        if (h.typeflag === TYPE_PAX) {
          const override = paxOverridePath(body);
          if (override !== undefined) pendingPath = override;
        }
        await skipBytes(blockPadding(h.size));
        continue;
      }

      const declared = pendingPath ?? (h.prefix ? `${h.prefix}/${h.name}` : h.name);
      pendingPath = undefined;
      const rel = safeTransferPath(declared); // guards the pax-or-header name; throws on escape
      const segs = rel.split("/");

      if (h.typeflag === TYPE_DIR) {
        // A directory carries no body (the writer emits size 0, GNU/BSD
        // readers agree). Skipping only the PADDING of a nonzero size would
        // desync the block stream, and every header after it would parse
        // mid-body - the honest answer is refusal before the mkdir, not a
        // skip that trusts the lying size in one direction and not the other.
        if (h.size !== 0) throw new Error(`tar: directory entry '${rel}' declares a ${h.size}-byte body`);
        if (++entries > limits.maxEntries) throw new Error(`tar: more than ${limits.maxEntries} entries`);
        // The header's recorded dir MODE is deliberately NOT applied. This is
        // the same reason the extractor never honors setuid or symlink modes:
        // a destination directory's permissions are the DESTINATION node's
        // decision, not a value the archive gets to impose, so recreating a
        // source's 0777 as a world-writable hole (or a 0500 that strands the
        // files the additive extract then writes into it) is exactly the class
        // of surprise this pass refuses. Every component lands as a real dir
        // under the fixed owner-only mode `ensureRealDir` sets; the writer
        // still carries the mode because it is standard ustar and a plain
        // `tar` on a workstation will honor it - we choose not to, here.
        ensureDirChain(segs, segs.length); // every component, leaf included, as a real dir
        continue;
      }
      if (h.typeflag !== TYPE_FILE) {
        throw new Error(`tar: refusing entry type '${h.typeflag}' (only files and directories transfer)`);
      }

      if (++entries > limits.maxEntries) throw new Error(`tar: more than ${limits.maxEntries} entries`);
      if (h.size > limits.maxFileBytes) throw new Error(`tar: entry '${rel}' exceeds the per-file cap`);
      if (bytes + h.size > limits.maxTotalBytes)
        throw new Error(`tar: extracted total exceeds ${limits.maxTotalBytes} bytes`);

      const parent = ensureDirChain(segs, segs.length - 1); // contain the ancestor dirs
      await writeBody(join(parent, segs[segs.length - 1]!), h.size, h.mode, h.mtime);
      files += 1;
      bytes += h.size;
      await skipBytes(blockPadding(h.size));
    }
  } finally {
    void it.return?.(undefined as never);
    gunzip.destroy();
    pump.destroy();
  }

  // Open and stream one file body. The leaf is opened O_NOFOLLOW: a symlinked
  // ancestor was already refused by ensureDirChain, and O_NOFOLLOW refuses an
  // existing OR mid-race-substituted symlink LEAF (a verified-but-hostile
  // archive could otherwise redirect a write outside the tree by naming a path
  // whose leaf is a symlink). Symlinks are not the only second name a leaf can
  // have, though: a HARD link to an outside file is a plain regular file to
  // open(), so O_NOFOLLOW cannot see it, and an open with O_TRUNC would punch
  // through the shared inode before any check could run. The open is therefore
  // NON-truncating, and the fstat that follows refuses a leaf with more than
  // one name before our own ftruncate runs. The fd is then chmod'd to the
  // recorded mode, so a replacement adopts the source's permissions whether it
  // CREATES or OVERWRITES (the write-stream `mode` option only bites at
  // creation, which silently left an overwriting 0600 file at a pre-existing
  // 0644).
  async function writeBody(leaf: string, size: number, mode: number, mtime: number): Promise<void> {
    let fd: number;
    try {
      fd = openSync(leaf, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP")
        throw new Error(`tar: refusing symlinked destination '${leaf}'`);
      throw err;
    }
    try {
      // After the non-truncating open and BEFORE any write: a destination with
      // two names shares its inode with the other one, and everything written
      // here would land there too. Freshly created files are nlink 1; only a
      // pre-existing hard link trips this.
      if (fstatSync(fd).nlink > 1) throw new Error(`tar: refusing hard-linked destination '${leaf}'`);
      ftruncateSync(fd, 0); // the truncation O_TRUNC used to do blindly, now after the guard
      // Both create and overwrite adopt the recorded mode: the write-stream
      // `mode` option only bites at CREATION, which silently left an
      // overwriting 0600 replacement at a pre-existing world-readable 0644.
      fchmodSync(fd, mode & 0o777);
      let written = 0;
      // We are the pump (nothing outruns us), so the body goes straight to the
      // fd with writeSync - no Writable stream, and so none of the
      // backpressure-listener or ERR_STREAM_DESTROYED handling a stream forced
      // the first version to carry (and which the compiled runtime handled
      // differently again). Still one chunk in memory at a time.
      while (written < size) {
        if (buf.length === 0 && !(await more())) throw new Error("tar: truncated archive (body)");
        const w = Math.min(size - written, buf.length);
        writeAll(fd, buf.subarray(0, w));
        buf = buf.subarray(w);
        written += w;
      }
      // Copy semantics: the source's time rides the header, so the landed file
      // gets it via the still-open fd (futimes, not a path-based utimes that a
      // swapped leaf could redirect). mtime 0 is the writer's "nobody said"
      // default, not a 1970 claim - leave those at write time.
      if (mtime > 0) futimesSync(fd, mtime, mtime);
    } finally {
      closeSync(fd);
    }
  }

  return { files, bytes };
}

// Write a whole buffer to an open fd, looping over any short write (regular
// files rarely split one, but a signal or ENOSPC retry can).
function writeAll(fd: number, data: Uint8Array): void {
  let off = 0;
  while (off < data.length) {
    const n = writeSync(fd, data, off, data.length - off);
    if (n <= 0) throw new Error("tar: short write to destination");
    off += n;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
