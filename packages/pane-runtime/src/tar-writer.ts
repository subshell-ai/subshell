/**
 * Streaming ustar/pax tar.gz WRITER for node-to-node archive transfer
 * (spec 2026-10-01 §3). Built on tar-blocks.ts; gzips via node:zlib's
 * createGzip, chosen by scripts/archive-streaming-probe.ts as the primitive
 * that streams at flat RSS in a compiled agent binary (the sync `Bun.gzipSync`
 * would force the whole uncompressed tar into RAM).
 *
 * No shell-out to `tar(1)`: the agent runs on hosts that may have no tar, and
 * the operator's ruling excludes any foreign binary. The writer never buffers
 * the tree - it reads each source file as a stream and writes it through in
 * blocks, enforcing the caps as bytes flow, not after.
 *
 * The archive's transport sha256 is the CALLER's job (computed over the
 * finished compressed staging file), because that is the exact byte span the
 * destination reassembles from relay windows and re-verifies.
 */

import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  BLOCK,
  blockPadding,
  buildHeader,
  needsPax,
  paxPathBlocks,
  safeTransferPath,
  TYPE_DIR,
  TYPE_FILE,
} from "./tar-blocks.js";

const enc = new TextEncoder();

/** A directory to record (so empty dirs survive the transfer). */
export interface ArchiveDir {
  /** Archive-relative posix path (no leading slash, no `..`); validated on write. */
  path: string;
  /** Low 9 permission bits; default 0o755. */
  mode?: number;
  /** Seconds since epoch for the header mtime; default 0. */
  mtimeSeconds?: number;
}

/** A file to place in the archive. */
export interface ArchiveFile {
  /** Archive-relative posix path (no leading slash, no `..`); validated on write. */
  path: string;
  /** Absolute path ON THIS MACHINE to read bytes from. */
  sourcePath: string;
  /** Byte size as last stat'd. The writer re-checks the true streamed length and throws if it drifted, so a wrong value fails loudly rather than corrupting the archive. */
  size: number;
  /** Low 9 permission bits; default 0o644. */
  mode?: number;
  /** Seconds since epoch; default 0. */
  mtimeSeconds?: number;
}

/** Caps enforced while streaming (spec 2026-10-01 §2); mirrored by the extractor. */
export interface ArchiveLimits {
  /** Largest single file that may enter the archive. */
  maxFileBytes: number;
  /** Largest total UNCOMPRESSED tar the archive may reach. */
  maxTotalBytes: number;
  /** Largest number of entries (files + dirs). */
  maxEntries: number;
}

/** A sink the writer needs: a Node Writable (e.g. `createWriteStream(path)`). */
type Writable = NodeJS.WritableStream;

export interface WriteResult {
  /** Entries written (files + dirs). */
  entries: number;
  /** Uncompressed tar bytes emitted (a checksum of the layout, not the transport digest). */
  tarBytes: number;
}

/**
 * Stream `dirs` then `files` as a gzip tar into `sink`. Throws naming the
 * violated cap or the unsafe path. Holds at most one source read chunk plus the
 * small gzip backpressure buffers - never the whole tree.
 */
export async function writeTarGz(
  dirs: ArchiveDir[],
  files: ArchiveFile[],
  sink: Writable,
  limits: ArchiveLimits,
): Promise<WriteResult> {
  let entries = 0;
  let tarBytes = 0;
  const counted = (b: Uint8Array): Uint8Array => {
    tarBytes += b.length;
    if (tarBytes > limits.maxTotalBytes) throw new Error(`tar: archive exceeds ${limits.maxTotalBytes} bytes`);
    return b;
  };

  async function* blocks(): AsyncGenerator<Uint8Array, void, unknown> {
    for (const d of dirs) {
      const rel = safeTransferPath(d.path);
      const name = `${rel}/`;
      if (++entries > limits.maxEntries) throw new Error(`tar: more than ${limits.maxEntries} entries`);
      if (needsPax(name)) for (const b of paxPathBlocks(name)) yield counted(b);
      yield counted(
        buildHeader({
          nameBytes: enc.encode(needsPax(name) ? "./PaxHeaders/.dir" : name),
          size: 0,
          mode: d.mode ?? 0o755,
          mtimeSeconds: d.mtimeSeconds ?? 0,
          typeflag: TYPE_DIR,
        }),
      );
    }

    for (const f of files) {
      const rel = safeTransferPath(f.path);
      if (++entries > limits.maxEntries) throw new Error(`tar: more than ${limits.maxEntries} entries`);
      if (f.size > limits.maxFileBytes) throw new Error(`tar: file '${rel}' exceeds the per-file cap`);
      if (needsPax(rel)) for (const b of paxPathBlocks(rel)) yield counted(b);
      yield counted(
        buildHeader({
          nameBytes: enc.encode(needsPax(rel) ? "./PaxHeaders/.file" : rel),
          size: f.size,
          mode: f.mode ?? 0o644,
          mtimeSeconds: f.mtimeSeconds ?? 0,
          typeflag: TYPE_FILE,
        }),
      );

      // Stream the body through in whole blocks, enforcing caps DURING. A short
      // tail is emitted whole and then zero-padded to the block boundary.
      let written = 0;
      const src = createReadStream(f.sourcePath);
      try {
        let carry: Uint8Array = new Uint8Array(0); // default ArrayBufferLike: stream chunks may carry either buffer kind
        for await (const raw of src) {
          carry = raw.byteLength === 0 ? carry : concatUint8(carry, raw as Uint8Array);
          while (carry.length >= BLOCK) {
            written += BLOCK;
            if (written > limits.maxFileBytes) throw new Error(`tar: file '${rel}' grew past its per-file cap`);
            yield counted(carry.subarray(0, BLOCK));
            carry = carry.subarray(BLOCK);
          }
        }
        if (carry.length > 0) {
          written += carry.length;
          if (written > limits.maxFileBytes) throw new Error(`tar: file '${rel}' grew past its per-file cap`);
          const padded = new Uint8Array(carry.length + blockPadding(carry.length));
          padded.set(carry);
          yield counted(padded);
        }
      } finally {
        src.destroy();
      }
      if (written !== f.size) throw new Error(`tar: file '${rel}' size drifted (declared ${f.size}, read ${written})`);
    }

    yield counted(new Uint8Array(BLOCK * 2)); // two zero blocks terminate the archive
  }

  await pipeline(blocks(), createGzip(), sink);
  return { entries, tarBytes };
}

function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
