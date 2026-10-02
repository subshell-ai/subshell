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
 *   - only regular files and directories are accepted; symlinks, hardlinks,
 *     devices, FIFOs and any other typeflag are refused outright (transfers
 *     copy trees; a link into the destination could point outside it);
 *   - per-file, total and entry caps run DURING the pass, so an archive that
 *     lies about its size cannot exhaust the destination before the cap fires;
 *   - the destination root's parents are created mode 0700, each file takes
 *     its recorded mode and (unless it is the writer's 0 "unstated" default)
 *     its recorded mtime; the extractor never deletes anything (additive by
 *     ruling - a transfer overwrites matching paths and leaves the rest).
 *
 * The transport sha256 is verified by the CALLER before this runs (against the
 * digest archive_create reported), so extract trusts only that the bytes are
 * what the source wrote, not that they are benign - benign-ness is these
 * guards' job.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  let pendingPath: string | undefined;

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

  try {
    for (;;) {
      if (!(await need(BLOCK))) break; // clean EOF without an explicit terminator
      const headerBlock = buf.subarray(0, BLOCK);
      if (isZeroBlock(headerBlock)) break;
      buf = buf.subarray(BLOCK);
      const h = parseHeader(headerBlock);

      if (h.typeflag === TYPE_PAX || h.typeflag === "g") {
        const body = await takeBytes(h.size);
        const override = paxOverridePath(body);
        if (override !== undefined) pendingPath = override;
        await skipBytes(blockPadding(h.size));
        continue;
      }

      const declared = pendingPath ?? (h.prefix ? `${h.prefix}/${h.name}` : h.name);
      pendingPath = undefined;

      if (h.typeflag === TYPE_DIR) {
        if (++entries > limits.maxEntries) throw new Error(`tar: more than ${limits.maxEntries} entries`);
        mkdirSync(join(destRoot, safeTransferPath(declared)), { recursive: true, mode: 0o700 });
        await skipBytes(blockPadding(h.size));
        continue;
      }
      if (h.typeflag !== TYPE_FILE) {
        throw new Error(`tar: refusing entry type '${h.typeflag}' (only files and directories transfer)`);
      }

      const rel = safeTransferPath(declared); // guards the pax-or-header name; throws on escape
      if (++entries > limits.maxEntries) throw new Error(`tar: more than ${limits.maxEntries} entries`);
      if (h.size > limits.maxFileBytes) throw new Error(`tar: entry '${rel}' exceeds the per-file cap`);
      if (bytes + h.size > limits.maxTotalBytes)
        throw new Error(`tar: extracted total exceeds ${limits.maxTotalBytes} bytes`);

      await writeBody(join(destRoot, rel), h.size, h.mode, h.mtime);
      files += 1;
      bytes += h.size;
      await skipBytes(blockPadding(h.size));
    }
  } finally {
    void it.return?.(undefined as never);
    gunzip.destroy();
    pump.destroy();
  }

  async function writeBody(path: string, size: number, mode: number, mtime: number): Promise<void> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const dst = createWriteStream(path, { mode: mode & 0o777 });
    // A listener is load-bearing: our own destroy() below races the pending
    // fd write, and Bun reports the resulting ERR_STREAM_DESTROYED as an
    // unhandled process error if 'error' has no handler. Real write failures
    // are captured here and re-thrown (the drain wait would hang otherwise).
    let failure: unknown;
    dst.on("error", (e) => {
      failure ??= e;
    });
    let written = 0;
    try {
      while (written < size) {
        if (buf.length === 0 && !(await more())) throw new Error("tar: truncated archive (body)");
        const w = Math.min(size - written, buf.length);
        if (!dst.write(buf.subarray(0, w))) {
          await Promise.race([once(dst, "drain"), once(dst, "error")]);
          if (failure) throw failure;
        }
        buf = buf.subarray(w);
        written += w;
      }
      dst.end();
      await once(dst, "close");
      if (failure) throw failure;
    } catch (e) {
      if (!dst.destroyed) dst.destroy();
      throw e;
    }
    // Copy semantics: the source's time rides the header, so the landed file
    // gets it (tar restores mtimes and a sync diff that re-timestamped every
    // relayed file would churn). mtime 0 is the writer's "nobody said"
    // default, not a 1970 claim - leave those at write time.
    if (mtime > 0) await utimes(path, mtime, mtime);
  }

  return { files, bytes };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
